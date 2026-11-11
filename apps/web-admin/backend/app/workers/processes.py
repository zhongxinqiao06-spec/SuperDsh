"""受管 CPU 工作进程基础；只接受服务注册的 Python 函数，不执行用户脚本。"""

import asyncio
import json
import multiprocessing
import os
import shutil
from collections.abc import Callable
from multiprocessing.connection import Connection
from pathlib import Path
from uuid import uuid4

from app.infrastructure.errors import DomainError

WorkFunction = Callable[[dict[str, object], str], dict[str, object]]


def execute(
    function: WorkFunction,
    payload: dict[str, object],
    directory: str,
    output: Connection,
    native_threads: int = 1,
) -> None:
    """隔离阻塞工作，返回上限内的 JSON；异常不携带路径、输入或堆栈。"""
    # 注册函数在调用时才加载数值库；每个工作进程独立限制内部线程，避免并发乘以CPU核数。
    # 只修改子进程环境，宿主API和用户终端配置保持各自的资源策略。
    for key in (
        "OPENBLAS_NUM_THREADS",
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ):
        os.environ[key] = str(native_threads)
    try:
        value = json.dumps({"ok": True, "value": function(payload, directory)}).encode()
        if len(value) > 1024 * 1024:
            value = b'{"ok":false,"code":"worker_output_limit"}'
    except DomainError as error:
        # 领域错误文本已由自有校验生成；保留可行动提示，不返回第三方堆栈或输入。
        value = json.dumps(
            {"ok": False, "status": error.status, "detail": error.detail[:1000], "code": error.code}
        ).encode()
    except Exception:
        value = b'{"ok":false,"code":"worker_failed"}'
    try:
        output.send_bytes(value)
    finally:
        output.close()


class ProcessWorkers:
    """有界并发、超时与取消；服务用例持有任务，HTTP 断开不会隐式重发。"""

    def __init__(self, root: Path, concurrency: int = 2, native_threads: int = 1) -> None:
        if not 1 <= concurrency <= 32 or not 1 <= native_threads <= 8:
            raise ValueError("工作进程并发和内部线程数必须处于允许范围")
        self.root = root.resolve()
        self.native_threads = native_threads
        self.limit = asyncio.Semaphore(concurrency)
        self.tasks: set[asyncio.Task[dict[str, object]]] = set()
        self.closing = False

    def submit(
        self, function: WorkFunction, payload: dict[str, object], timeout: float = 120
    ) -> asyncio.Task[dict[str, object]]:
        """创建应用生命周期内的任务；调用方将稳定 job ID/收据另行持久化。"""
        if self.closing:
            raise DomainError(503, "workers are shutting down")
        if timeout <= 0 or timeout > 3600 or len(json.dumps(payload).encode()) > 1024 * 1024:
            raise DomainError(422, "invalid worker limits")
        task = asyncio.create_task(self._run(function, payload, timeout))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def _run(
        self, function: WorkFunction, payload: dict[str, object], duration: float
    ) -> dict[str, object]:
        async with self.limit:
            directory = self.root / str(uuid4())
            directory.mkdir(parents=True)
            context = multiprocessing.get_context("spawn")
            receiving, sending = context.Pipe(duplex=False)
            process = context.Process(
                target=execute,
                args=(function, payload, str(directory), sending, self.native_threads),
                daemon=True,
            )
            try:
                process.start()
                sending.close()
                async with asyncio.timeout(duration):
                    while not receiving.poll():
                        if not process.is_alive():
                            raise DomainError(502, "worker exited without a result")
                        await asyncio.sleep(0.025)
                    raw = await asyncio.to_thread(receiving.recv_bytes, 1024 * 1024)
                    result = json.loads(raw)
                    if result.get("ok") is not True or not isinstance(result.get("value"), dict):
                        raise DomainError(
                            int(result.get("status", 502)),
                            str(result.get("detail", "worker failed")),
                            str(result.get("code", "worker_failed")),
                        )
                    return dict(result["value"])
            except TimeoutError as error:
                raise DomainError(504, "worker timed out", "worker_timeout") from error
            except (EOFError, OSError) as error:
                raise DomainError(
                    502, "worker response was interrupted", "worker_failed"
                ) from error
            finally:
                if process.pid is not None:
                    if process.is_alive():
                        process.terminate()
                    await asyncio.to_thread(process.join, 5)
                    if process.is_alive():
                        process.kill()
                        await asyncio.to_thread(process.join, 5)
                    process.close()
                receiving.close()
                sending.close()
                # 仅清理由本对象创建的唯一子目录，拒绝越界清理。
                if directory.resolve().parent != self.root:
                    raise RuntimeError("工作目录边界变化，拒绝清理")
                await asyncio.to_thread(shutil.rmtree, directory)

    async def close(self) -> None:
        """退出先取消全部任务，再等待进程退出与临时目录清理。"""
        self.closing = True
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

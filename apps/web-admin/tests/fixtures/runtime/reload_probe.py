"""独立监听端口的重载探针，不导入业务装配、数据库或真实密钥。"""

import argparse
import asyncio
import faulthandler
import json
import os
import signal
import sys
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from uvicorn.supervisors.watchfilesreload import WatchFilesReload

from app.infrastructure import development_server


def record(kind: str, child: int | None, returncode: int | None = None) -> None:
    """只记录合成进程身份与清理事实。"""
    with Path(os.environ["RELOAD_PROBE_OUTPUT"]).open("a", encoding="utf-8") as stream:
        stream.write(
            json.dumps({"kind": kind, "pid": os.getpid(), "child": child, "returncode": returncode})
            + "\n"
        )


def create_app() -> FastAPI:
    """每代工作进程持有一个合成子进程，退出时等待回收以验证生命周期。"""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        child = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-c", "import time; time.sleep(600)"
        )
        record("startup", child.pid)
        try:
            yield
        finally:
            if child.returncode is None:
                child.terminate()
                await asyncio.wait_for(child.wait(), 5)
            record("shutdown", child.pid, child.returncode)

    app = FastAPI(lifespan=lifespan)

    @app.get("/probe")
    async def probe() -> dict[str, object]:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-B",
            "-c",
            "print('subprocess-ready')",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        return {
            "pid": os.getpid(),
            "childCode": process.returncode,
            "output": stdout.decode().strip(),
            "errors": stderr.decode().strip(),
        }

    return app


def main() -> None:
    """在独立隐藏控制台运行真实重载器，独立停止标记仅用于发送退出信号。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--watch", type=Path, required=True)
    parser.add_argument("--stop", type=Path, required=True)
    args = parser.parse_args()

    class ProbeReload(WatchFilesReload):
        """测试退出通过监督器自己的停止事件，worker 仍执行真实信号/ASGI 清理。"""

        def startup(self) -> None:
            super().startup()

            def stop() -> None:
                record("monitor-start", self.process.pid)
                while not args.stop.exists():
                    time.sleep(0.1)
                record("stop-seen", self.process.pid)
                self.should_exit.set()

            threading.Thread(target=stop, daemon=True).start()

        def shutdown(self) -> None:
            # 必须由持有控制台的主线程发送，与真实 Uvicorn restart 相同。
            assert self.process.pid is not None
            os.kill(
                self.process.pid,
                signal.CTRL_C_EVENT if sys.platform == "win32" else signal.SIGTERM,
            )
            sys.stdout.write(" ")
            sys.stdout.flush()
            faulthandler.dump_traceback_later(5)
            super().shutdown()
            faulthandler.cancel_dump_traceback_later()

    # 只增加测试控制入口，不替换 restart、socket、watcher 或工作进程实现。
    development_server.ChangeReload = ProbeReload
    development_server.run_development_server(
        uvicorn.Config(
            "fixtures.runtime.reload_probe:create_app",
            factory=True,
            host="127.0.0.1",
            port=args.port,
            workers=1,
            loop="app.infrastructure.event_loop:create_event_loop",
            reload=True,
            reload_dirs=[str(args.watch)],
            timeout_graceful_shutdown=10,
        )
    )


if __name__ == "__main__":
    main()

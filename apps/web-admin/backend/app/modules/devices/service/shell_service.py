"""设备 Shell 请求与持久收据；未知结果不自动重放，重启明确标记中断。"""

import asyncio
import hashlib
import json
import logging
import os
import signal
import subprocess
import sys
from datetime import UTC, datetime
from typing import TYPE_CHECKING, cast
from uuid import uuid4

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.devices.dao.operation_dao import OperationDao
from app.modules.devices.entity.do.operation_do import ShellTaskRow
from app.modules.devices.entity.vo.operation_vo import ShellInput
from app.modules.devices.service.operation_paths import operation_path
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.devices.service.device_service import DeviceService


class ShellService:
    """Shell 仅响应已授权终端用例，不接管 DSH 队列或自动执行模型生成的命令。"""

    def __init__(self, devices: "DeviceService", database: Database) -> None:
        self.devices, self.database = devices, database
        self.tasks: dict[str, asyncio.Task[None]] = {}

    @staticmethod
    def view(row: ShellTaskRow) -> dict[str, object]:
        """状态字段兼容旧任务查询，命令内容仅返回所属账号。"""
        return {
            "taskId": row.id,
            "connectorId": row.connector_id,
            "sessionId": row.session_id,
            "command": row.command,
            "cwd": row.cwd,
            "timeoutMs": row.timeout_ms,
            "status": row.state,
            "result": row.result,
            "error": row.error,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def authorize(self, credential: str, owner: str, connector: str) -> Account:
        """运行中撤销会话、权限或阻断设备都会终止本地等待。"""
        account = await self.devices.identity.authenticate(credential)
        account.require("terminal.use")
        row = await self.devices.own(account, connector, "terminal.use")
        if account.user_id != owner or row.blocked_at or row.revoked:
            raise DomainError(403, "终端操作授权已失效")
        return account

    async def initialize(self) -> None:
        """唯一服务所有权建立后收束旧记录，不猜测未知命令是否可以重试。"""
        async with self.database.sessions() as session, session.begin():
            for row in await OperationDao(session).unfinished():
                row.state, row.error, row.updated_at = (
                    "failed",
                    {
                        "code": "execution_interrupted",
                        "message": "服务重启中断等待；命令结果未知，请核实后再操作",
                    },
                    datetime.now(UTC),
                )

    async def start(
        self, account: Account, credential: str, connector: str, value: ShellInput
    ) -> dict[str, object]:
        """持久化稳定操作 ID 后才开始执行；同幂等身份不重复运行 Shell。"""
        root, cwd, local = await operation_path(
            self.devices,
            account,
            connector,
            value.root or (value.cwd if value.cwd != "." else None),
            value.cwd,
            "terminal.use",
        )
        await self.authorize(credential, account.user_id, connector)
        if len(self.tasks) >= 64:
            raise DomainError(429, "Shell 操作繁忙")
        identifier = "task_" + (
            hashlib.sha256(
                (account.user_id + ":" + connector + ":" + value.operationId).encode()
            ).hexdigest()[:40]
            if value.operationId
            else uuid4().hex
        )
        request_hash = hashlib.sha256(
            json.dumps(
                {**value.model_dump(exclude={"operationId"}), "root": root, "cwd": cwd},
                sort_keys=True,
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "device-shell:" + identifier)
            dao = OperationDao(session)
            previous = await dao.task(identifier, account.user_id)
            if previous:
                if previous.request_hash != request_hash:
                    raise DomainError(409, "同一操作标识不能提交不同命令")
                return self.view(previous)
            now = datetime.now(UTC)
            row = ShellTaskRow(
                id=identifier,
                owner_id=account.user_id,
                connector_id=connector,
                session_id="browse_" + connector,
                command=value.command,
                request_hash=request_hash,
                root=root,
                cwd=cwd,
                timeout_ms=value.timeoutMs,
                state="running",
                result=None,
                error=None,
                created_at=now,
                updated_at=now,
            )
            await dao.save(row)
            receipt = self.view(row)
        task = asyncio.create_task(self._run(row, value, credential, local))
        self.tasks[identifier] = task
        task.add_done_callback(lambda completed: self._finished(identifier, completed))
        return receipt

    def _finished(self, identifier: str, task: asyncio.Task[None]) -> None:
        if self.tasks.get(identifier) is task:
            self.tasks.pop(identifier, None)
        if not task.cancelled():
            task.exception()

    async def _monitor(self, credential: str, owner: str, connector: str) -> None:
        while True:
            await self.authorize(credential, owner, connector)
            await asyncio.sleep(0.5)

    async def _run(
        self, row: ShellTaskRow, value: ShellInput, credential: str, local: bool
    ) -> None:
        state = "failed"
        result: dict[str, object] | None = None
        error: dict[str, object] | None = None
        try:
            async with asyncio.timeout((row.timeout_ms + 5000) / 1000):
                work = asyncio.create_task(
                    self._local(row, value) if local else self._remote(row, value, credential)
                )
                monitor = asyncio.create_task(
                    self._monitor(credential, row.owner_id, row.connector_id)
                )
                try:
                    done, _ = await asyncio.wait(
                        {work, monitor}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if monitor in done:
                        await monitor
                    result = await work
                    await self.authorize(credential, row.owner_id, row.connector_id)
                    state = "completed"
                finally:
                    work.cancel()
                    monitor.cancel()
                    await asyncio.gather(work, monitor, return_exceptions=True)
        except asyncio.CancelledError:
            error = {
                "code": "execution_interrupted",
                "message": "Shell 等待已中止，远端结果需另行核实",
            }
        except TimeoutError:
            error = {"code": "execution_timeout", "message": "Shell 操作超时，远端结果需另行核实"}
        except (DomainError, OSError):
            error = {"code": "execution_failed", "message": "Shell 操作失败或授权已失效"}
        except Exception as cause:
            logging.getLogger(__name__).error(
                "device.shell.failed", extra={"task_id": row.id, "error_type": type(cause).__name__}
            )
            error = {"code": "execution_failed", "message": "Shell 操作失败，请核实任务结果"}
        async with self.database.sessions() as session, session.begin():
            current = await OperationDao(session).task(row.id, row.owner_id)
            if current and current.state == "running":
                current.state, current.result, current.error, current.updated_at = (
                    state,
                    result,
                    error,
                    datetime.now(UTC),
                )

    async def _remote(
        self, row: ShellTaskRow, value: ShellInput, credential: str
    ) -> dict[str, object]:
        account = await self.authorize(credential, row.owner_id, row.connector_id)
        result = await self.devices.call(
            account,
            row.connector_id,
            "shell.exec",
            {
                **value.model_dump(exclude={"operationId"}),
                "taskId": row.id,
                "sessionId": row.session_id,
                "root": row.root,
                "cwd": row.cwd,
            },
            "terminal.use",
            (row.timeout_ms + 5000) / 1000,
        )
        if not isinstance(result, dict):
            raise DomainError(502, "设备 Shell 结果无效")
        if len(json.dumps(result).encode()) > 4 * 1024 * 1024:
            raise DomainError(413, "设备 Shell 输出超过限制")
        return cast(dict[str, object], result)

    async def _local(self, row: ShellTaskRow, value: ShellInput) -> dict[str, object]:
        """工作目录限定本人 Home/workspace；超时或撤权会终止本代理创建的进程树。"""
        cwd = self.devices.files.resolve(row.owner_id, row.cwd)
        cwd.mkdir(parents=True, exist_ok=True)
        home = self.devices.workspace(row.owner_id).parent / "home"
        home.mkdir(parents=True, exist_ok=True)
        if any(
            not key or "=" in key or "\x00" in key + text or len(text) > 16384
            for key, text in value.env.items()
        ):
            raise DomainError(422, "Shell 环境变量无效")
        command = (
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                value.command,
            ]
            if os.name == "nt"
            else ["/bin/sh", "-c", value.command]
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=cwd,
            env={**os.environ, **value.env, "HOME": str(home), "USERPROFILE": str(home)},
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **(
                {"creationflags": subprocess.CREATE_NO_WINDOW}
                if os.name == "nt"
                else {"start_new_session": True}
            ),
        )

        async def read(stream: asyncio.StreamReader | None) -> str:
            data = bytearray()
            if stream:
                while chunk := await stream.read(65536):
                    data.extend(chunk)
                    if len(data) > 2 * 1024 * 1024:
                        raise DomainError(413, "Shell 输出超过限制")
            return data.decode("utf-8", errors="replace")

        readers = [
            asyncio.create_task(read(process.stdout)),
            asyncio.create_task(read(process.stderr)),
        ]
        try:
            # RPC 外围预留的传输宽限不延长本地命令自身的执行期限。
            async with asyncio.timeout(row.timeout_ms / 1000):
                stdout, stderr = await asyncio.gather(*readers)
                code = await process.wait()
            return {"stdout": stdout, "stderr": stderr, "exitCode": code, "timedOut": False}
        finally:
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            if process.returncode is None:
                if sys.platform == "win32":
                    killer = await asyncio.create_subprocess_exec(
                        "taskkill",
                        "/PID",
                        str(process.pid),
                        "/T",
                        "/F",
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    await asyncio.wait_for(killer.wait(), 10)
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                await asyncio.wait_for(process.wait(), 10)

    async def wait(
        self, account: Account, credential: str, connector: str, identifier: str, timeout_ms: int
    ) -> dict[str, object]:
        """轮询只读取已有操作，不创建或重试命令；超时返回当前持久状态。"""
        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        while True:
            await self.authorize(credential, account.user_id, connector)
            async with self.database.sessions() as session:
                row = await OperationDao(session).task(identifier, account.user_id)
                if not row or row.connector_id != connector:
                    raise DomainError(404, "Shell 任务不存在")
                result = self.view(row)
            if row.state != "running" or asyncio.get_running_loop().time() >= deadline:
                return result
            await asyncio.sleep(0.1)

    async def execute(
        self, account: Account, credential: str, connector: str, value: ShellInput
    ) -> dict[str, object]:
        """同步入口也先持久化收据，调用取消不会把未知结果当作可重发失败。"""
        receipt = await self.start(account, credential, connector, value)
        completed = await self.wait(
            account, credential, connector, str(receipt["taskId"]), value.timeoutMs + 5000
        )
        if completed["status"] != "completed":
            raise DomainError(
                504 if completed["status"] == "running" else 409,
                "Shell 操作未成功完成，请通过任务收据核实",
            )
        return {
            "ok": True,
            "result": completed["result"],
            "error": None,
            "taskId": receipt["taskId"],
        }

    async def close(self) -> None:
        """关闭时等待所有本地进程清理与任务收据落库。"""
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()

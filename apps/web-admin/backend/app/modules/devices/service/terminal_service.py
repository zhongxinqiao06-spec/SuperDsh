"""受管终端生命周期、背压与输出恢复，不参与 DSH 消息执行队列。"""

import asyncio
import base64
import contextlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.devices.entity.vo.device_dto import TerminalInput
from app.modules.devices.entity.vo.terminal_result import TerminalResult
from app.modules.devices.service.device_service import DeviceService
from app.modules.devices.service.terminal_process import TerminalProcess, spawn
from app.modules.devices.service.workspace_service import WorkspaceService
from app.modules.identity.entity.bo.models import Account


@dataclass
class Terminal:
    """每个终端保存有界滚动缓冲，序号不随截断回退。"""

    id: str
    owner: str
    connector: str
    session: str | None
    name: str
    cwd: str
    cols: int
    rows: int
    persistence: bool
    process: TerminalProcess
    sequence: int = 0
    chunks: list[tuple[int, str]] = field(default_factory=list)
    buffered: int = 0
    status: str = "running"
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    root: str = ""
    task: asyncio.Task[None] | None = None
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class TerminalService:
    """实例只在明确关闭、进程退出、权限撤销或服务退出时回收。"""

    def __init__(self, devices: DeviceService, workspace: WorkspaceService) -> None:
        self.devices, self.workspace = devices, workspace
        self.terminals: dict[str, Terminal] = {}
        self._creation = asyncio.Lock()

    @staticmethod
    def view(row: Terminal) -> dict[str, object]:
        return {
            "id": row.id,
            "terminalId": row.id,
            "connectorId": row.connector,
            "sessionId": row.session,
            "name": row.name,
            "label": row.name,
            "title": row.name,
            "cwd": row.cwd,
            "root": row.root,
            "purpose": "user",
            "pid": row.process.pid,
            "cols": row.cols,
            "rows": row.rows,
            "persistence": row.persistence,
            "persistent": row.persistence,
            "status": row.status,
            "sequence": row.sequence,
            "scrollbackSeq": row.sequence,
            "scrollbackBytes": row.buffered,
            "createdAt": row.created_at,
        }

    @classmethod
    def protocol_view(cls, row: Terminal) -> dict[str, object]:
        """原生终端暴露设备协议字段，规范UI额外别名不改变旧设备响应形态。"""
        view = cls.view(row)
        return {
            key: view[key]
            for key in (
                "terminalId",
                "sessionId",
                "root",
                "cwd",
                "label",
                "cols",
                "rows",
                "purpose",
                "pid",
                "status",
                "persistent",
                "scrollbackBytes",
                "scrollbackSeq",
                "createdAt",
            )
        }

    async def create(self, account: Account, connector: str, value: TerminalInput) -> object:
        row = await self.devices.own(account, connector, "terminal.use")
        if row.executor_kind != "server-agent":
            return await self.devices.operations.relay.create(account, connector, value)
        async with self._creation:
            if (
                sum(
                    item.owner == account.user_id and item.status == "running"
                    for item in self.terminals.values()
                )
                >= 8
            ):
                raise DomainError(429, "too many active terminals")
            from app.modules.devices.service.operation_paths import operation_path

            root, path, _ = await operation_path(
                self.devices, account, connector, value.root, value.cwd, "terminal.use"
            )
            cwd = self.workspace.resolve(account.user_id, path)
            process = await asyncio.to_thread(
                spawn,
                cwd,
                self.devices.workspace(account.user_id).parent / "home",
                value.rows,
                value.cols,
                value.shell,
                value.args,
            )
            terminal = Terminal(
                "trm_" + uuid4().hex,
                account.user_id,
                connector,
                value.sessionId or "browse_" + connector,
                value.name,
                str(cwd),
                value.cols,
                value.rows,
                value.persistence,
                process,
                root=root,
            )
            if not process.alive():
                await asyncio.to_thread(process.close)
                raise DomainError(502, "terminal failed to start")
            if value.command:
                try:
                    await asyncio.to_thread(process.write, value.command + "\r")
                except BaseException:
                    await asyncio.to_thread(process.close)
                    raise
            self.terminals[terminal.id] = terminal
            terminal.task = asyncio.create_task(self._collect(terminal))
            return TerminalResult(
                {"terminal": self.view(terminal), "serverTime": datetime.now(UTC).isoformat()},
                self.protocol_view(terminal),
            )

    async def _collect(self, terminal: Terminal) -> None:
        try:
            while terminal.process.alive():
                account = await self.devices.identity.get_account(terminal.owner)
                account.require("terminal.use")
                text = await asyncio.to_thread(terminal.process.read)
                if text:
                    terminal.sequence += 1
                    terminal.chunks.append((terminal.sequence, text))
                    terminal.buffered += len(text.encode())
                    while terminal.buffered > 1024 * 1024 and terminal.chunks:
                        terminal.buffered -= len(terminal.chunks.pop(0)[1].encode())
                await asyncio.sleep(0.1 if text else 0.25)
        except asyncio.CancelledError:
            raise
        except (OSError, EOFError, DomainError):
            terminal.status = "error"
        finally:
            if terminal.status == "running":
                terminal.status = "exited"
            with contextlib.suppress(OSError):
                await asyncio.to_thread(terminal.process.close)

    async def _own(self, account: Account, connector: str, identifier: str) -> Terminal:
        await self.devices.own(account, connector, "terminal.use")
        terminal = self.terminals.get(identifier)
        if not terminal or terminal.owner != account.user_id or terminal.connector != connector:
            raise DomainError(404, "terminal not found")
        return terminal

    async def listing(self, account: Account, connector: str, session: str | None = None) -> object:
        row = await self.devices.own(account, connector, "terminal.use")
        if row.executor_kind != "server-agent":
            result = await self.devices.call(
                account,
                connector,
                "terminal.list",
                {"sessionId": session or "browse_" + connector},
                "terminal.use",
            )
            if not isinstance(result, dict):
                raise DomainError(502, "终端响应无效")
            return TerminalResult({**result, "serverTime": datetime.now(UTC).isoformat()}, result)
        selected = [
            item
            for item in self.terminals.values()
            if item.owner == account.user_id
            and item.connector == connector
            and item.session == (session or "browse_" + connector)
        ]
        return TerminalResult(
            {
                "terminals": [self.view(item) for item in selected],
                "serverTime": datetime.now(UTC).isoformat(),
            },
            {"terminals": [self.protocol_view(item) for item in selected]},
        )

    async def action(
        self,
        account: Account,
        connector: str,
        identifier: str,
        action: str,
        value: dict[str, object],
    ) -> object:
        # 本地与远端共用边界校验，不把非法参数交由远端设备兜底。
        if action == "resize":
            cols, rows = value.get("cols"), value.get("rows")
            if (
                type(cols) is not int
                or type(rows) is not int
                or not 1 <= cols <= 500
                or not 1 <= rows <= 200
            ):
                raise DomainError(422, "invalid terminal dimensions")
        elif action == "rename":
            name = value.get("name", value.get("label"))
            if not isinstance(name, str) or not name.strip() or len(name) > 100:
                raise DomainError(422, "invalid terminal name")
            value = {**value, "name": name.strip()}
        elif action == "persistence":
            persistence = value.get("persistence", value.get("persistent"))
            if not isinstance(persistence, bool):
                raise DomainError(422, "invalid terminal persistence")
            value = {**value, "persistence": persistence}
        row = await self.devices.own(account, connector, "terminal.use")
        if row.executor_kind != "server-agent":
            result = await self.devices.operations.relay.call(
                account,
                connector,
                identifier,
                action,
                {
                    **value,
                    **(
                        {"persistent": value.get("persistence", value.get("persistent"))}
                        if action == "persistence"
                        else {}
                    ),
                    **(
                        {"label": value.get("name", value.get("label"))}
                        if action == "rename"
                        else {}
                    ),
                },
            )
            return TerminalResult(result, result)
        terminal = await self._own(account, connector, identifier)
        async with terminal.write_lock:
            if action == "close":
                terminal.status = "exited"
                if terminal.task:
                    terminal.task.cancel()
                    await asyncio.gather(terminal.task, return_exceptions=True)
                self.terminals.pop(identifier, None)
            elif action == "write":
                data = value.get("data")
                if isinstance(value.get("dataBase64"), str):
                    try:
                        data = base64.b64decode(str(value["dataBase64"]), validate=True).decode(
                            "utf-8"
                        )
                    except (ValueError, UnicodeDecodeError) as error:
                        raise DomainError(422, "invalid terminal input") from error
                if not isinstance(data, str) or len(data.encode()) > 65536:
                    raise DomainError(422, "invalid terminal input")
                if terminal.status != "running":
                    raise DomainError(409, "terminal is not running")
                await asyncio.to_thread(terminal.process.write, data)
            elif action == "resize":
                cols, rows = value.get("cols"), value.get("rows")
                if (
                    not isinstance(cols, int)
                    or not isinstance(rows, int)
                    or not 1 <= cols <= 500
                    or not 1 <= rows <= 200
                ):
                    raise DomainError(422, "invalid terminal dimensions")
                await asyncio.to_thread(terminal.process.resize, rows, cols)
                terminal.cols, terminal.rows = cols, rows
            elif action == "rename":
                name = value.get("name")
                if not isinstance(name, str) or not name.strip() or len(name) > 100:
                    raise DomainError(422, "invalid terminal name")
                terminal.name = name.strip()
            elif action == "persistence":
                persistence = value.get("persistence", value.get("persistent"))
                if not isinstance(persistence, bool):
                    raise DomainError(422, "invalid terminal persistence")
                terminal.persistence = persistence
            else:
                raise DomainError(404, "terminal action not found")
        return TerminalResult(
            {"terminal": self.view(terminal), "serverTime": datetime.now(UTC).isoformat()},
            self.protocol_view(terminal),
        )

    async def snapshot(
        self, account: Account, connector: str, identifier: str, after: int = 0
    ) -> object:
        row = await self.devices.own(account, connector, "terminal.use")
        if row.executor_kind != "server-agent":
            result = await self.devices.operations.relay.call(
                account, connector, identifier, "snapshot", {"afterSeq": after, "fromSeq": after}
            )
            encoded = result.get("dataBase64", "")
            try:
                text = base64.b64decode(str(encoded), validate=True).decode(
                    "utf-8", errors="replace"
                )
            except ValueError as error:
                raise DomainError(502, "invalid terminal snapshot") from error
            return TerminalResult(
                {
                    **result,
                    "data": text,
                    "sequence": result.get("seq", result.get("sequence", 0)),
                },
                result,
            )
        terminal = await self._own(account, connector, identifier)
        data = "".join(text for seq, text in terminal.chunks if seq > after)
        return TerminalResult(
            {
                "terminal": self.view(terminal),
                "sequence": terminal.sequence,
                "seq": terminal.sequence,
                "data": data,
                "dataBase64": base64.b64encode(data.encode()).decode(),
                "reset": bool(terminal.chunks and after < terminal.chunks[0][0] - 1),
            },
            {
                **self.protocol_view(terminal),
                "dataBase64": base64.b64encode(
                    "".join(text for _, text in terminal.chunks).encode()
                ).decode(),
                "seq": terminal.sequence,
            },
        )

    async def close(self) -> None:
        """服务退出等待所有进程清理，不遗留本代理启动的 Shell。"""
        tasks = [row.task for row in self.terminals.values() if row.task]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.terminals.clear()

    async def authorize_scope(
        self, account: Account, connector: str, identifier: str, session: str | None
    ) -> None:
        """会话终端入口必须匹配创建时的会话绑定，不能跨会话引用终端。"""
        row = await self.devices.own(account, connector, "terminal.use")
        if row.executor_kind != "server-agent":
            await self.devices.operations.relay.binding(
                account, connector, identifier, session or "browse_" + connector
            )
        else:
            terminal = await self._own(account, connector, identifier)
            if terminal.session != (session or "browse_" + connector):
                raise DomainError(404, "terminal not found")

"""固定引擎子进程生命周期；仅继承运行所需白名单环境。"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import sys
import uuid
from pathlib import Path

from app.modules.runtime.service.ports import ToolCall

from .diagnostics import safe_startup_diagnostic
from .process_tree import WindowsProcessTree
from .protocol import FRAME_LIMIT, Fields, RuntimeFailure, fields

ENV_ALLOWLIST = {
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "LANG",
    "LC_ALL",
    "TZ",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
}


def child_environment(home: Path, workspace: Path, anchor: Path, gateway: Fields) -> dict[str, str]:
    """用户目录是产品隔离边界；不将其描述为操作系统沙箱。"""
    environment = {key: value for key, value in os.environ.items() if key.upper() in ENV_ALLOWLIST}
    temporary = home / "tmp"
    temporary.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(home / "appdata"),
            "LOCALAPPDATA": str(home / "localappdata"),
            "TMP": str(temporary),
            "TEMP": str(temporary),
            "TMPDIR": str(temporary),
            "DSH_HOME": str(home),
            "DSH_WORKSPACE": str(workspace),
            "WEB_ADMIN_HARNESS_ANCHOR": str(anchor),
            "SUPERDSH_MODEL_GATEWAY": json.dumps(gateway),
            "NO_COLOR": "1",
        }
    )
    return environment


class HarnessProcess:
    """唯一受管 Host；标准输入关闭、取消或租约失效都必须回收进程树。"""

    def __init__(
        self,
        node: str,
        anchor: Path,
        home: Path,
        workspace: Path,
        gateway: Fields,
        owner: str,
        tool_call: ToolCall,
    ) -> None:
        self.node, self.anchor, self.home, self.workspace = node, anchor, home, workspace
        self.gateway, self.owner, self.tool_call = gateway, owner, tool_call
        self.process: asyncio.subprocess.Process | None = None
        self.ready = asyncio.Event()
        self.failed = asyncio.Event()
        self._readers: list[asyncio.Task[None]] = []
        self._calls: dict[str, asyncio.Task[None]] = {}
        self._installations: dict[str, asyncio.Future[None]] = {}
        self._default_reads: dict[str, asyncio.Future[Fields]] = {}
        self._write_lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self.diagnostics: list[str] = []
        self._tree = WindowsProcessTree()

    async def start(self) -> None:
        """只运行已安装且已编译的固定产品包，不从子模块临时加载。"""
        adapter = self.anchor.parents[3] / "web-admin/engine-adapter/dist/host.mjs"
        if (
            not self.anchor.is_file()
            or not (self.anchor.parent / "lib/host-runtime.js").is_file()
            or not adapter.is_file()
        ):
            raise RuntimeFailure("runtime_assets_missing", "固定引擎产物未准备，请运行构建")
        manifest = fields(json.loads(self.anchor.read_text("utf-8")))
        pinned = fields(manifest.get("dependencies")).get("@deepseek-ai/dsh")
        installed = self.anchor.parent / "node_modules/@deepseek-ai/dsh/package.json"
        if (
            not installed.is_file()
            or fields(json.loads(installed.read_text("utf-8"))).get("version") != pinned
        ):
            raise RuntimeFailure("runtime_pin_mismatch", "引擎安装产物与固定来源不一致")
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.home.is_symlink() or self.workspace.is_symlink():
            raise RuntimeFailure("runtime_path_invalid", "运行目录必须由平台独占")
        self.process = await asyncio.create_subprocess_exec(
            self.node,
            str(adapter),
            cwd=self.workspace,
            env=child_environment(self.home, self.workspace, self.anchor, self.gateway),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=FRAME_LIMIT + 1,
            start_new_session=os.name != "nt",
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        try:
            self._tree.attach(self.process.pid)
        except BaseException:
            self.process.kill()
            await self.process.wait()
            raise
        assert self.process.stdout is not None and self.process.stderr is not None
        self._readers = [
            asyncio.create_task(self._read(self.process.stdout, True)),
            asyncio.create_task(self._read(self.process.stderr, False)),
        ]
        ready = asyncio.create_task(self.ready.wait())
        failed = asyncio.create_task(self.failed.wait())
        exited = asyncio.create_task(self.process.wait())
        try:
            done, _ = await asyncio.wait(
                {ready, failed, exited}, timeout=90, return_when=asyncio.FIRST_COMPLETED
            )
            if ready not in done or self.failed.is_set() or self.process.returncode is not None:
                raise RuntimeFailure("runtime_start_failed", "固定引擎启动失败或超时")
        except BaseException:
            await self.stop()
            raise
        finally:
            for task in (ready, failed, exited):
                task.cancel()
            await asyncio.gather(ready, failed, exited, return_exceptions=True)

    async def _read(self, reader: asyncio.StreamReader, controls: bool) -> None:
        try:
            while line := await reader.readline():
                if len(line) > FRAME_LIMIT:
                    raise RuntimeFailure("runtime_frame_too_large", "引擎控制帧过大")
                marker = b"@@superdsh-runtime@@"
                if controls and line.startswith(marker):
                    await self._control(fields(json.loads(line[len(marker) :])))
                else:
                    # 仅用于本进程诊断，不能向 API 客户端返回原始日志或环境信息。
                    self.diagnostics.append(line.decode("utf-8", errors="replace")[-2000:])
                    del self.diagnostics[:-20]
        except (ValueError, ConnectionError, RuntimeFailure):
            self.failed.set()

    async def _control(self, message: Fields) -> None:
        kind, identifier = message.get("type"), message.get("id")
        if kind == "host-ready":
            self.ready.set()
        elif kind == "runtime-defaults" and isinstance(identifier, str):
            pending = self._default_reads.get(identifier)
            if pending and not pending.done():
                if message.get("error") or not isinstance(message.get("defaults"), dict):
                    pending.set_exception(
                        RuntimeFailure(
                            "permission_default_unavailable", "无法读取引擎默认权限", 409
                        )
                    )
                else:
                    pending.set_result(fields(message["defaults"]))
        elif kind == "host-error":
            diagnostic = safe_startup_diagnostic(message)
            self.diagnostics.append(json.dumps(diagnostic, ensure_ascii=False))
            del self.diagnostics[:-20]
            logging.getLogger("web_admin").warning(
                "runtime_host_start_failed",
                extra={"code": ":".join(diagnostic.values())},
            )
            self.failed.set()
        elif kind in {"tool-installed", "preset-installed"} and isinstance(identifier, str):
            future = self._installations.get(identifier)
            if future and not future.done():
                if message.get("error"):
                    future.set_exception(RuntimeFailure("tool_install_failed", "工具安装失败"))
                else:
                    future.set_result(None)
        elif kind == "tool-call" and isinstance(identifier, str):
            if len(self._calls) >= 64 or identifier in self._calls:
                await self.send({"type": "tool-result", "id": identifier, "error": True})
                return
            task = asyncio.create_task(self._invoke(identifier, message))
            self._calls[identifier] = task
            task.add_done_callback(lambda _task: self._calls.pop(identifier, None))
        elif kind == "tool-cancel" and isinstance(identifier, str):
            pending_call = self._calls.get(identifier)
            if pending_call:
                pending_call.cancel()

    async def _invoke(self, identifier: str, message: Fields) -> None:
        try:
            raw_timeout = message.get("timeoutSeconds", 300)
            timeout = (
                min(600, max(30, raw_timeout)) if isinstance(raw_timeout, (int, float)) else 300
            )
            result = await asyncio.wait_for(self.tool_call(self.owner, message), timeout)
            await self.send({"type": "tool-result", "id": identifier, "result": result})
        except (Exception, asyncio.CancelledError):
            with contextlib.suppress(ConnectionError, RuntimeFailure):
                await self.send({"type": "tool-result", "id": identifier, "error": True})

    async def send(self, message: Fields) -> None:
        """发送有界控制帧；此通道不提交会话命令。"""
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        if len(data) > FRAME_LIMIT:
            raise RuntimeFailure("runtime_frame_too_large", "引擎控制帧过大")
        async with self._write_lock:
            if (
                self.process is None
                or self.process.stdin is None
                or self.process.returncode is not None
            ):
                raise RuntimeFailure("runtime_disconnected", "引擎进程不可用")
            self.process.stdin.write(data)
            await self.process.stdin.drain()

    async def runtime_defaults(self) -> Fields:
        """从同一 Host 读取公开默认配置；有界等待且取消后不接收迟到响应。"""
        if len(self._default_reads) >= 32:
            raise RuntimeFailure(
                "permission_default_unavailable", "引擎默认权限读取繁忙，请重试", 409
            )
        identifier = str(uuid.uuid4())
        future: asyncio.Future[Fields] = asyncio.get_running_loop().create_future()
        self._default_reads[identifier] = future
        try:
            async with asyncio.timeout(10):
                await self.send({"type": "runtime-defaults", "id": identifier})
                return await future
        except (TimeoutError, ConnectionError, RuntimeFailure) as error:
            raise RuntimeFailure(
                "permission_default_unavailable",
                "引擎默认权限暂不可用，请重新准备服务端 Agent",
                409,
            ) from error
        finally:
            self._default_reads.pop(identifier, None)
            if not future.done():
                future.cancel()

    async def install_tool(self, tool: Fields) -> None:
        """注册显式授权的冻结工具描述；修订替换需先结束原运行。"""
        identifier = str(uuid.uuid4())
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._installations[identifier] = future
        try:
            await self.send({"type": "tool-install", "id": identifier, "tool": tool})
            await asyncio.wait_for(future, 15)
        finally:
            self._installations.pop(identifier, None)

    async def install_preset(self, preset: Fields) -> None:
        """只通过固定适配插件安装受控提示与工具作用域，不接收任意插件路径。"""
        identifier = str(uuid.uuid4())
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._installations[identifier] = future
        try:
            await self.send({"type": "preset-install", "id": identifier, "preset": preset})
            await asyncio.wait_for(future, 20)
        finally:
            self._installations.pop(identifier, None)

    async def stop(self) -> None:
        """先优雅关闭，超时终止所属进程树；确认退出之后调用方才可解锁。"""
        async with self._stop_lock:
            process = self.process
            if process is not None and process.returncode is None:
                with contextlib.suppress(ConnectionError, RuntimeFailure):
                    await self.send({"type": "shutdown"})
                try:
                    await asyncio.wait_for(process.wait(), 8)
                except TimeoutError:
                    if sys.platform == "win32":
                        self._tree.close()
                    else:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(process.pid, signal.SIGKILL)
                    await asyncio.wait_for(process.wait(), 10)
            self._tree.close()
            if process is not None and sys.platform != "win32":
                # Host 异常退出时仍终止其独立会话的剩余孙进程。
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            if process is not None and process.stdin:
                process.stdin.close()
                with contextlib.suppress(ConnectionError, OSError):
                    await process.stdin.wait_closed()
            # 等待 EOF 使 Proactor 管道自然关闭；提前取消 reader 会留下底层 transport。
            if self._readers:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*self._readers, return_exceptions=True), 5
                    )
                except TimeoutError:
                    for reader in self._readers:
                        reader.cancel()
            for task in self._calls.values():
                task.cancel()
            await asyncio.gather(*self._calls.values(), *self._readers, return_exceptions=True)
            for future in self._installations.values():
                if not future.done():
                    future.set_exception(RuntimeFailure("runtime_disconnected", "引擎已停止"))
            for pending in self._default_reads.values():
                if not pending.done():
                    pending.set_exception(RuntimeFailure("runtime_disconnected", "引擎已停止"))

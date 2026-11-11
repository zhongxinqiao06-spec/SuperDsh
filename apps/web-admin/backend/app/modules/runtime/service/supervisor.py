"""唯一运行监督器；只管理生命周期，不添加另一条 Agent 执行队列。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.integrations.dsh.bridge import RuntimeBridge
from app.integrations.dsh.gateway import ModelGateway
from app.integrations.dsh.process import HarnessProcess
from app.integrations.dsh.process_identity import machine_identity, process_is_alive
from app.integrations.dsh.protocol import Fields, Json, RuntimeFailure, fields
from app.integrations.dsh.sync import ProjectionSync
from app.modules.runtime.service.agent_selection_service import AgentSelectionService
from app.modules.runtime.service.model_selection_service import ModelSelectionService
from app.modules.runtime.service.permission_selection_service import PermissionSelectionService
from app.modules.runtime.service.ports import (
    Authorize,
    ModelProvider,
    Ownership,
    OwnershipProvider,
    ProjectionStore,
    ToolCall,
)


@dataclass
class RunningHost:
    """一次运行代际的全部资源，清理时不得影响后继代际。"""

    owner: str
    generation: str
    lease: Ownership
    gateway: ModelGateway
    process: HarnessProcess
    bridge: RuntimeBridge
    sync: ProjectionSync
    monitor: asyncio.Task[None] | None = None
    available: bool = False
    tools: dict[str, Fields] = field(default_factory=dict)


class RuntimeSupervisor:
    """按用户复用固定 Host；未握手或失去租约的实例不能接收执行请求。"""

    def __init__(
        self,
        root: Path,
        anchor: Path,
        node: str,
        release: str,
        ownership: OwnershipProvider,
        store: ProjectionStore,
        models: ModelProvider,
        authorize: Authorize,
        tool_call: ToolCall,
        heartbeat_seconds: float = 5,
    ) -> None:
        if not root.is_absolute() or not anchor.is_absolute():
            raise RuntimeFailure("runtime_path_invalid", "运行目录与引擎安装锚点必须为绝对路径")
        self.root, self.anchor, self.node, self.release = root, anchor, node, release
        self.ownership, self.store, self.models = ownership, store, models
        self.authorize, self.tool_call = authorize, tool_call
        self.heartbeat_seconds = heartbeat_seconds
        self._hosts: dict[str, RunningHost] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._states: dict[str, Fields] = {}
        self._closed = False
        self._platform_lease: Ownership | None = None
        self._platform_monitor: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """平台监督器必须唯一；多 API worker 会明确争用失败。"""
        self._platform_lease = await self.ownership.acquire("__platform_supervisor__")
        self._platform_monitor = asyncio.create_task(self._watch_platform())

    async def _watch_platform(self) -> None:
        while not self._closed:
            await asyncio.sleep(self.heartbeat_seconds)
            if self._platform_lease is None or not await self._platform_lease.check():
                await self.close()
                return

    def _identity(self, owner: str) -> tuple[str, str, str]:
        digest = hashlib.sha256(owner.encode()).hexdigest()
        return digest, f"conn_server_{digest[:24]}", f"proj_server_{digest[:24]}"

    def status(self, owner: str) -> Fields:
        """状态查询不创建目录、租约或 Host；管理页面不会隐式启动引擎。"""
        _, connector, project = self._identity(owner)
        state = self._states.get(owner, {"status": "stopped", "error": None})
        return {**state, "connectorId": connector, "projectId": project, "runtimeId": "dsh"}

    async def is_ready(self) -> bool:
        """监督器失去所有权即不就绪，状态对象仍存在不能掩盖故障。"""
        return (
            not self._closed
            and self._platform_lease is not None
            and await self._platform_lease.check()
        )

    async def prepare(self, owner: str) -> Fields:
        """显式准备并等待 Host 与持久 Connector 双就绪，失败回收后才可重试。"""
        async with self._locks.setdefault(owner, asyncio.Lock()):
            await self.authorize(owner)
            if (
                self._closed
                or self._platform_lease is None
                or not await self._platform_lease.check()
            ):
                raise RuntimeFailure("runtime_supervisor_unavailable", "运行监督器不可用")
            current = self._hosts.get(owner)
            if current is not None and current.available and await current.lease.check():
                return self.status(owner)
            if current is not None:
                await self._dispose(current)
            self._states[owner] = {"status": "starting", "error": None}
            try:
                lease = await self.ownership.acquire(owner)
            except Exception as error:
                code = (
                    error.code
                    if isinstance(error, RuntimeFailure)
                    else "runtime_ownership_unavailable"
                )
                self._states[owner] = {"status": "error", "error": code}
                if isinstance(error, RuntimeFailure):
                    raise
                raise RuntimeFailure(code, "运行所有权暂不可用") from error
            gateway = ModelGateway(owner, self.models, self.authorize)
            run: RunningHost | None = None
            generation = uuid.uuid4().hex
            claimed = False
            startup_stage = "execution-fence"
            try:
                machine = machine_identity()
                prior = await self.store.fence(owner)
                if prior:
                    pid = prior.get("pid")
                    if (
                        prior.get("machine") != machine
                        or not isinstance(pid, int)
                        or process_is_alive(pid)
                    ):
                        raise RuntimeFailure(
                            "runtime_recovery_required", "原执行者尚未确认退出，需要恢复检查", 409
                        )
                    await self.store.release_execution(owner, str(prior["generation"]))
                await self.store.claim_execution(owner, generation, machine)
                claimed = True
                digest, connector, _ = self._identity(owner)
                directory = self.root / digest
                home, workspace = directory / "home", directory / "workspace"
                if any(path.is_symlink() for path in (self.root, directory, home, workspace)):
                    raise RuntimeFailure("runtime_path_invalid", "运行目录链不能包含符号链接")
                startup_stage = "model-gateway"
                origin = await gateway.start()
                process = HarnessProcess(
                    self.node,
                    self.anchor,
                    home,
                    workspace,
                    {"origin": origin, "secret": gateway.secret},
                    owner,
                    self._authorized_tool,
                )
                bridge = RuntimeBridge()
                sync = ProjectionSync(bridge, self.store, owner)
                run = RunningHost(owner, generation, lease, gateway, process, bridge, sync)
                self._hosts[owner] = run
                # 从进程启动起就监测租约，不能在漫长启动期间失去所有权继续执行。
                run.monitor = asyncio.create_task(self._watch(run))
                startup_stage = "harness-process"
                await process.start()
                assert process.process is not None
                startup_stage = "execution-attach"
                await self.store.attach_execution(owner, generation, process.process.pid)
                startup_stage = "runtime-bridge"
                await bridge.connect(home, connector, self.release)
                startup_stage = "projection-sync"
                await sync.start()
                assert sync.task is not None
                ready = asyncio.create_task(sync.ready.wait())
                disconnected = asyncio.create_task(bridge.disconnected.wait())
                try:
                    done, _ = await asyncio.wait(
                        {ready, disconnected, sync.task},
                        timeout=30,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if ready not in done or bridge.disconnected.is_set():
                        raise RuntimeFailure(
                            "runtime_connector_unavailable", "运行时 Connector 未就绪"
                        )
                finally:
                    ready.cancel()
                    disconnected.cancel()
                    await asyncio.gather(ready, disconnected, return_exceptions=True)
                if not await lease.check() or self._hosts.get(owner) is not run:
                    raise RuntimeFailure("runtime_ownership_lost", "运行所有权已失效")
                run.available = True
                self._states[owner] = {"status": "running", "error": None}
                return self.status(owner)
            except BaseException as error:
                if not isinstance(error, asyncio.CancelledError):
                    # 仅记录固定阶段与异常类型，不输出供应商正文、环境或可能携带凭据的异常消息。
                    logging.getLogger(__name__).error(
                        "runtime_start_failed owner=%s stage=%s error_type=%s",
                        owner,
                        startup_stage,
                        type(error).__name__,
                    )
                self._states[owner] = {
                    "status": "error",
                    "error": error.code
                    if isinstance(error, RuntimeFailure)
                    else "runtime_start_failed",
                }
                if run is not None:
                    await self._dispose(run)
                else:
                    await gateway.close()
                    if claimed:
                        await self.store.release_execution(owner, generation)
                    await lease.release()
                raise

    async def _authorized_tool(self, owner: str, message: Fields) -> Json:
        await self.authorize(owner)
        run = self._hosts.get(owner)
        if run is None or not run.available or not await run.lease.check():
            raise RuntimeFailure("runtime_ownership_lost", "工具执行所有权失效")
        tool_id = message.get("toolId")
        tool = run.tools.get(tool_id) if isinstance(tool_id, str) else None
        if (
            tool is None
            or tool.get("revision") != message.get("revision")
            or not isinstance(message.get("externalSessionId"), str)
            or not isinstance(message.get("callId"), str)
            or not message["callId"]
        ):
            raise RuntimeFailure("tool_binding_invalid", "工具冻结引用无效", 403)
        state = fields(
            await run.bridge.request(
                "session.getState", {"externalSessionId": message["externalSessionId"]}
            )
        )
        allowed_sessions = tool.get("sessionIds")
        if not isinstance(allowed_sessions, list) or state.get("sessionId") not in allowed_sessions:
            raise RuntimeFailure("tool_session_not_bound", "当前会话没有绑定此工具修订", 403)
        return await self.tool_call(owner, {**message, "sessionId": state.get("sessionId")})

    async def _watch(self, run: RunningHost) -> None:
        while self._hosts.get(run.owner) is run:
            await asyncio.sleep(self.heartbeat_seconds)
            try:
                await self.authorize(run.owner)
                alive = await run.lease.check()
            except Exception:
                alive = False
            process = run.process.process
            if (
                not alive
                or run.process.failed.is_set()
                or (process is not None and process.returncode is not None)
                or run.bridge.disconnected.is_set()
            ):
                self._states[run.owner] = {
                    "status": "error",
                    "error": "runtime_ownership_or_connection_lost",
                }
                await self._dispose(run)
                return

    async def _dispose(self, run: RunningHost) -> None:
        # 先撤销接收能力，再关闭协议和回收进程；进程退出失败保留租约，不能双主。
        run.available = False
        if run.monitor is not None and run.monitor is not asyncio.current_task():
            run.monitor.cancel()
            await asyncio.gather(run.monitor, return_exceptions=True)
        await run.bridge.close()
        await run.sync.close()
        await run.gateway.close()
        await run.process.stop()
        await self.store.release_execution(run.owner, run.generation)
        await run.lease.release()
        if self._hosts.get(run.owner) is run:
            self._hosts.pop(run.owner, None)

    async def stop(self, owner: str) -> None:
        """显式停止只影响当前用户，等待子进程退出才返回。"""
        async with self._locks.setdefault(owner, asyncio.Lock()):
            current = self._hosts.get(owner)
            if current:
                await self._dispose(current)
            self._states[owner] = {"status": "stopped", "error": None}

    async def call(self, owner: str, method: str, params: Fields) -> Json:
        """唯一命令路径；写命令发送前持久收据，拒绝客户端选择 Host 目录。"""
        await self.authorize(owner)
        run = self._hosts.get(owner)
        if run is None or not run.available or not await run.lease.check():
            raise RuntimeFailure("runtime_not_ready", "请先准备服务端 Agent", 409)
        allowed = {
            "catalog.listModels",
            "catalog.listPermissions",
            "catalog.listAgentPresets",
            "session.createAndStart",
            "session.startTurn",
            "session.interrupt",
            "session.list",
            "session.getState",
            "session.respondInteraction",
            "session.updateSelections",
            "runtime.sync.refresh",
            "runtime.getCapabilities",
            "session.getCapabilities",
            "session.getNotices",
            "session.getSnapshot",
        }
        if method not in allowed:
            raise RuntimeFailure("runtime_method_unsupported", "不支持的运行时操作", 422)
        if "cwd" in params or "runtimeId" in params and params["runtimeId"] != "dsh":
            raise RuntimeFailure("runtime_path_owned", "运行目录和引擎由平台管理", 422)
        if method == "catalog.listModels":
            catalog = fields(await run.bridge.request(method, params))
            return await ModelSelectionService(self.models).annotate(owner, catalog)
        if method == "catalog.listPermissions":
            return await PermissionSelectionService().catalog(run.bridge, run.process)
        if method == "session.updateSelections":
            await ModelSelectionService(self.models).validate_explicit(owner, params, run.bridge)
        if method not in {"session.createAndStart", "session.startTurn"}:
            return await run.bridge.request(method, params)
        identifier, session = params.get("clientMessageId"), params.get("sessionId")
        if (
            not isinstance(identifier, str)
            or not 0 < len(identifier) <= 128
            or not isinstance(session, str)
            or not session
        ):
            raise RuntimeFailure("runtime_idempotency_required", "需要稳定消息和会话标识", 422)
        digest = hashlib.sha256(
            json.dumps(
                {"method": method, "params": params}, sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
        receipt = hashlib.sha256(f"{session}:{identifier}".encode()).hexdigest()
        command = params
        # 重试先核对原收据；配置撤销也不能让已完成的发送再次执行或变成新失败。
        completed, prior = await self.store.replay(owner, receipt, digest)
        if completed:
            return prior
        if method == "session.createAndStart":
            # 摘要基于原始请求；默认值变化不能重发已经完成或结果未知的执行。
            command = await ModelSelectionService(self.models).apply_default(
                owner, params, run.bridge
            )
            command = await AgentSelectionService().apply_default(command, run.bridge)
            command = await PermissionSelectionService().apply_default(
                command, run.bridge, run.process
            )
        else:
            await ModelSelectionService(self.models).validate_explicit(owner, params, run.bridge)
        created, prior = await self.store.reserve(owner, receipt, digest)
        if not created:
            return prior
        result = await run.bridge.request(method, {**command, "cwd": str(run.process.workspace)})
        await self.store.settle(owner, receipt, result)
        return result

    async def events(self, owner: str, after: int = 0) -> list[Fields]:
        """事件读取经过当前授权，可在 Host 关闭后读取已完成证据。"""
        await self.authorize(owner)
        return await self.store.events(owner, after)

    async def install_tool(self, owner: str, tool: Fields) -> None:
        """仅由已授权工具用例调用；实际回调仍校验会话与冻结修订。"""
        await self.authorize(owner)
        run = self._hosts.get(owner)
        if run is None or not run.available:
            raise RuntimeFailure("runtime_not_ready", "运行时尚未就绪")
        identifier, revision = tool.get("id"), tool.get("revision")
        if (
            not isinstance(identifier, str)
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 1
        ):
            raise RuntimeFailure("tool_binding_invalid", "工具描述必须包含稳定标识和修订", 422)
        session_ids = tool.get("sessionIds")
        if (
            not isinstance(session_ids, list)
            or not session_ids
            or len(session_ids) > 100
            or any(not isinstance(value, str) or not value for value in session_ids)
        ):
            raise RuntimeFailure("tool_session_not_bound", "工具必须显式冻结绑定会话", 422)
        previous = run.tools.get(identifier)
        if previous is not None and previous != tool:
            raise RuntimeFailure("tool_binding_frozen", "当前 Host 工具描述已经冻结", 409)
        await run.process.install_tool(tool)
        run.tools[identifier] = fields(json.loads(json.dumps(tool)))

    async def install_preset(self, owner: str, preset: Fields) -> None:
        """安装前复验运行代际，业务层仅提交固定插件可识别的冻结字段。"""
        await self.authorize(owner)
        run = self._hosts.get(owner)
        if run is None or not run.available or not await run.lease.check():
            raise RuntimeFailure("runtime_not_ready", "运行时尚未就绪")
        await run.process.install_preset(preset)

    async def close(self) -> None:
        """服务退出时先停止全部 Host，再释放平台唯一监督器锁。"""
        self._closed = True
        if self._platform_monitor and self._platform_monitor is not asyncio.current_task():
            self._platform_monitor.cancel()
            await asyncio.gather(self._platform_monitor, return_exceptions=True)
        failures = []
        for owner in list(self._hosts):
            try:
                await self.stop(owner)
            except Exception as error:
                failures.append(error)
        if failures:
            raise RuntimeFailure("runtime_cleanup_failed", "部分运行进程未确认退出") from failures[
                0
            ]
        if self._platform_lease:
            await self._platform_lease.release()
            self._platform_lease = None

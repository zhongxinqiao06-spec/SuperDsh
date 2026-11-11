"""在应用组合根连接身份、数据库和固定引擎，模块导入不启动进程。"""

from collections.abc import AsyncIterator

from app.build_metadata import read_build_info
from app.infrastructure.configuration import Settings
from app.infrastructure.database import Database
from app.infrastructure.errors import DomainError
from app.infrastructure.runtime_ownership import PostgresOwnershipProvider
from app.integrations.dsh.protocol import Fields, Json
from app.modules.identity.service.identity import IdentityService
from app.modules.runtime.service.ports import ModelProvider, ToolCall
from app.modules.runtime.service.projection import SqlProjectionStore
from app.modules.runtime.service.runtime import RuntimeService

from .supervisor import RuntimeSupervisor


class UnconfiguredModels:
    """未配置模型时保留真实历史同步能力，执行请求明确失败而不造回答。"""

    async def catalog(self, owner: str) -> Fields:
        """没有模型配置，目录如实为空；完整模型配置由业务迁移阶段注入。"""
        return {"scope": None, "providers": []}

    async def stream(self, owner: str, path: str, body: Fields) -> AsyncIterator[bytes]:
        """禁止将未迁移能力伪装为成功模型调用。"""
        raise DomainError(409, "尚未配置模型", "model_unavailable")
        yield b""


async def unavailable_tool(owner: str, request: Fields) -> Json:
    """未接入授权工具用例时拒绝所有回调，不开放任意代码执行。"""
    raise DomainError(403, "工具尚未授权", "tool_not_authorized")


async def create_runtime(
    settings: Settings,
    db: Database,
    identity: IdentityService,
    models: ModelProvider | None = None,
    tool_call: ToolCall = unavailable_tool,
) -> RuntimeService:
    """取得平台监督器锁但不启动 Host；仅工作台显式准备才创建用户进程。"""

    async def authorize(owner: str) -> None:
        account = await identity.get_account(owner)
        account.require("sessions.run")

    runner = RuntimeSupervisor(
        root=settings.runtime_state_root or settings.data_dir / "runtime",
        anchor=settings.repository_root / "apps/desktop/plugins/harness/package.json",
        node=settings.node_executable,
        release=str(read_build_info()["version"]),
        ownership=PostgresOwnershipProvider(db.engine),
        store=SqlProjectionStore(db.sessions),
        models=models or UnconfiguredModels(),
        authorize=authorize,
        tool_call=tool_call,
    )
    await runner.start()
    return RuntimeService(runner, authorize)

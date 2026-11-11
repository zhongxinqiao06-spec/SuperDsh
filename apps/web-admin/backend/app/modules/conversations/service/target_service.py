"""会话导入与首次执行共用目标校验，不能静默覆盖客户端选择的工作目录。"""

from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text
from app.modules.conversations.dao.conversation_dao import ConversationRepository
from app.modules.conversations.entity.bo.workspace import workspace_key
from app.modules.conversations.entity.do.models import ProjectRow
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account


class SessionTargetService:
    """只验证既有设备、项目和运行配置，不负责发现、准备或启动。"""

    def __init__(self, repository: ConversationRepository, devices: DeviceService) -> None:
        self.repository, self.devices = repository, devices

    async def resolve(
        self,
        account: Account,
        connector_id: str,
        project_id: str | None,
        runtime_id: str,
        runtime_type: str,
        cwd: str | None,
    ) -> ProjectRow:
        """用户目标不匹配时明确拒绝；旧受管逻辑/workspace仅在唯一绑定通过后转换。"""
        connector = await self.devices.own(account, connector_id, "sessions.run")
        identifier = required_text(project_id, "projectId")
        async with self.repository.transaction() as dao:
            project = await dao.project(identifier)
        if not project or project.owner_id != account.user_id:
            raise DomainError(404, "project not found")
        if project.connector_id != connector.id:
            raise DomainError(422, "project belongs to a different connector")
        native = connector.executor_kind == "server-agent"
        if native:
            managed_connector, managed_project = self.devices.native_ids(account.user_id)
            if (
                connector.id != managed_connector
                or project.id != managed_project
                or runtime_id != "dsh"
            ):
                raise DomainError(403, "server Agent target is managed by the platform")
        if cwd and not (native and cwd == "/workspace"):
            if workspace_key(cwd, connector.device_os) != workspace_key(
                project.workspace_path, connector.device_os
            ):
                raise DomainError(422, "cwd must match the selected project")
        await self.devices.runtimes.require_configured(
            account, connector.id, runtime_id, runtime_type
        )
        return project

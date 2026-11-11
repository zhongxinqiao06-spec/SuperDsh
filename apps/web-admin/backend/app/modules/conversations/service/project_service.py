"""项目侧栏与工作区归属，删除项目不会删除磁盘目录或源会话。"""

from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text
from app.modules.conversations.dao.conversation_dao import ConversationRepository
from app.modules.conversations.entity.bo.workspace import workspace_key
from app.modules.conversations.entity.do.models import ProjectRow, SessionRow
from app.modules.conversations.entity.vo.conversation_dto import ProjectInput
from app.modules.conversations.service.views import project_view
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account


class ProjectService:
    """项目不创建执行队列，仅描述设备工作目录与侧栏组织。"""

    def __init__(self, repository: ConversationRepository, devices: DeviceService) -> None:
        self.repository, self.devices = repository, devices

    async def ensure_native(self, owner: str) -> None:
        """仅显式准备Agent时登记唯一受管工作区；重复调用不能更新用户项目或刷新时间。"""
        account = await self.devices.identity.get_account(owner)
        account.require("sessions.run")
        connector, identifier = self.devices.native_ids(owner)
        path = str(self.devices.workspace(owner))
        async with self.repository.transaction() as dao:
            await dao.lock("projects:" + owner)
            prior = await dao.project(identifier)
            if prior:
                if (
                    prior.owner_id != owner
                    or prior.connector_id != connector
                    or workspace_key(prior.workspace_path) != workspace_key(path)
                ):
                    raise DomainError(409, "managed project identity conflict")
                return
            now = datetime.now(UTC)
            await dao.save(
                ProjectRow(
                    id=identifier,
                    owner_id=owner,
                    connector_id=connector,
                    name="服务器 Agent",
                    workspace_path=path,
                    manually_created=False,
                    pinned=False,
                    created_at=now,
                    updated_at=now,
                )
            )

    async def listing(self, account: Account) -> dict[str, object]:
        account.require("projects.read")
        sources = await self.devices.conversation_sources(account, "projects.read")
        async with self.repository.transaction() as dao:
            projects, sessions = (
                await dao.projects(account.user_id),
                await dao.sessions(account.user_id),
            )
        return {
            "projects": [
                project_view(row, sessions) for row in projects if row.connector_id in sources
            ],
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def create(self, account: Account, value: ProjectInput) -> dict[str, object]:
        account.require("projects.manage")
        connector = await self.devices.own(account, value.connectorId, "projects.manage")
        path = required_text(value.workspacePath, "workspacePath").strip()
        name = required_text(value.name, "name", 255).strip()
        key = workspace_key(path, connector.device_os)
        now = datetime.now(UTC)
        async with self.repository.transaction() as dao:
            await dao.lock("projects:" + account.user_id)
            if connector.executor_kind == "server-agent":
                # 受管项目由运行时准备，不允许借通用项目入口创建其他工作区或覆盖绑定。
                connector_id, project_id = self.devices.native_ids(account.user_id)
                managed = await dao.project(project_id)
                if (
                    connector.id != connector_id
                    or not managed
                    or managed.owner_id != account.user_id
                    or managed.connector_id != connector.id
                    or workspace_key(managed.workspace_path, connector.device_os) != key
                ):
                    raise DomainError(403, "server Agent workspace is managed by the platform")
                return self.created_view(managed, await dao.sessions(account.user_id))
            existing = next(
                (
                    row
                    for row in await dao.projects(account.user_id)
                    if row.connector_id == value.connectorId
                    and workspace_key(row.workspace_path, connector.device_os) == key
                ),
                None,
            )
            if existing:
                return self.created_view(existing, await dao.sessions(account.user_id))
            row = ProjectRow(
                id="proj_" + uuid4().hex,
                owner_id=account.user_id,
                connector_id=value.connectorId,
                name=name,
                workspace_path=path,
                pinned=False,
                manually_created=value.manuallyCreated,
                created_at=now,
                updated_at=now,
            )
            await dao.save(row)
            return self.created_view(row, [])

    @staticmethod
    def created_view(row: ProjectRow, sessions: list[SessionRow]) -> dict[str, object]:
        """项目创建/复用都返回原客户端读取的统计字段，不隐式迁移已有会话。"""
        return {
            "project": project_view(row, sessions),
            "attachedSessions": 0,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def update(
        self, account: Account, identifier: str, value: dict[str, object], remove: bool = False
    ) -> dict[str, object]:
        account.require("projects.manage")
        if set(value) - {"name", "pinned"}:
            raise DomainError(422, "unsupported project changes")
        async with self.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.project(identifier)
            if not row or row.owner_id != account.user_id:
                raise DomainError(404, "project not found")
            sessions = await dao.sessions(account.user_id)
            if remove:
                if identifier == self.devices.native_ids(account.user_id)[1]:
                    raise DomainError(409, "server Agent workspace is managed by the platform")
                detached = 0
                for item in sessions:
                    if item.project_id == identifier:
                        item.project_id = None
                        await dao.save(item)
                        detached += 1
                await dao.remove(row)
                return {
                    "deleted": True,
                    "projectId": identifier,
                    "detachedSessions": detached,
                    "serverTime": datetime.now(UTC).isoformat(),
                }
            if "name" in value:
                name = value["name"]
                if not isinstance(name, str) or not name.strip() or len(name) > 255:
                    raise DomainError(422, "invalid project name")
                row.name = name.strip()
            if "pinned" in value:
                if not isinstance(value["pinned"], bool):
                    raise DomainError(422, "invalid pin state")
                row.pinned = value["pinned"]
                row.pinned_at = datetime.now(UTC) if row.pinned else None
            row.updated_at = datetime.now(UTC)
            await dao.save(row)
            return {"project": project_view(row, sessions)}

"""会话批量读标记及归档，先核验完整目标集合再提交，避免部分越权写入。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import ConversationDao
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


class SessionBatchService:
    """批量操作不经过展示分页，保留旧ID数组、数量上限及读游标语义。"""

    def __init__(self, conversations: "ConversationService") -> None:
        self.conversations = conversations

    async def _apply(self, dao: ConversationDao, row: SessionRow, operation: str) -> None:
        if operation == "read":
            # 读标记不属于新会话事实，不能人为增加恢复序号或制造未读状态。
            row.last_read_seq = max(row.sequence, row.latest_turn_end_seq)
        else:
            row.archived = operation == "archive"
            row.archived_at = datetime.now(UTC) if row.archived else None
            previous_updated = row.updated_at
            await self.conversations.projection.emit(dao, row, "session.meta.updated", {})
            row.updated_at = previous_updated
        await dao.save(row)

    async def update(self, account: Account, operation: str, value: object) -> dict[str, object]:
        """数组中的重复ID按旧协议计数；任一归属无效时全部不写入。"""
        account.require("sessions.run")
        if operation not in {"read", "archive", "unarchive"}:
            raise DomainError(404, "session action not found")
        if (
            not isinstance(value, list)
            or len(value) > 1000
            or any(not isinstance(item, str) for item in value)
        ):
            raise DomainError(422, "expected an array of session IDs")
        identifiers = [str(item) for item in value]
        for identifier in identifiers:
            row = await self.conversations.own(account, identifier, "sessions.run")
            await self.conversations.devices.own(account, row.connector_id, "sessions.run")
        async with self.conversations.repository.transaction() as dao:
            # 固定加锁次序，交叉数组并发不会因用户提供顺序相反而死锁。
            for identifier in sorted(set(identifiers)):
                await dao.lock(identifier)
            rows: list[SessionRow] = []
            for identifier in identifiers:
                current = await dao.session(identifier)
                if (
                    not current
                    or current.owner_id != account.user_id
                    or current.source.get("historyDeletedAt")
                ):
                    raise DomainError(404, "session not found")
                rows.append(current)
            for row in rows:
                await self._apply(dao, row, operation)
        return {
            "sessions": [
                await self.conversations.view(account, row, "sessions.run") for row in rows
            ],
            "affected": len(rows),
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def archive_all(
        self, account: Account, target: str, project: bool, value: dict[str, object]
    ) -> dict[str, object]:
        """按已授权项目/设备取全部会话；旧scope字段不参与筛选，false表示取消归档。"""
        account.require("sessions.run")
        if project:
            async with self.conversations.repository.transaction() as dao:
                bound = await dao.project(target)
            if not bound or bound.owner_id != account.user_id:
                raise DomainError(404, "project not found")
            await self.conversations.devices.own(account, bound.connector_id, "sessions.run")
        else:
            await self.conversations.devices.own(account, target, "sessions.run")
        async with self.conversations.repository.transaction() as dao:
            rows = await dao.scoped_sessions(account.user_id, target, project)
            for row in sorted(rows, key=lambda item: item.id):
                await dao.lock(row.id)
            # 锁等待期间可能有其它修改，重新读取条件集合，保持持久状态权威。
            for row in rows:
                await dao.refresh_session(row)
            rows = [row for row in rows if not row.source.get("historyDeletedAt")]
            operation = "unarchive" if value.get("archived") is False else "archive"
            for row in rows:
                await self._apply(dao, row, operation)
        return {
            "sessions": [
                await self.conversations.view(account, row, "sessions.run") for row in rows
            ],
            "affected": len(rows),
            "serverTime": datetime.now(UTC).isoformat(),
        }

"""会话清单与有界分页分开，兼容客户端全量目录且避免页面游标依赖锚点存活。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.bo.session_cursor import SessionCursor, cursor_time
from app.modules.conversations.entity.vo.timeline_query import query_integer
from app.modules.conversations.service.views import session_view
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


class SessionListingService:
    """所有列表按持久活动排序；完整目录不套展示页上限或隐藏归档会话。"""

    def __init__(self, conversations: "ConversationService") -> None:
        self.conversations = conversations

    async def listing(
        self, account: Account, filters: dict[str, str], inventory: bool = False
    ) -> dict[str, object]:
        account.require("sessions.read")
        await self.conversations.projection.sync(account)
        sources = await self.conversations.devices.conversation_sources(account)
        # 旧inventory入口忽略查询串；规范分页入口仍支持前端的项目/设备及搜索筛选。
        selected_filters = {} if inventory else filters
        limit = None if inventory else query_integer(filters.get("limit"), 100, 1, 100)
        cursor = (
            SessionCursor.decode(filters["cursor"])
            if not inventory and filters.get("cursor")
            else None
        )
        async with self.conversations.repository.transaction() as dao:
            project_id = selected_filters.get("projectId")
            if project_id:
                project = await dao.project(project_id)
                if not project or project.owner_id != account.user_id:
                    raise DomainError(404, "project not found")
            rows = await dao.session_page(
                account.user_id, list(sources), selected_filters, cursor, limit, inventory
            )
        page = rows if limit is None else rows[:limit]
        more = limit is not None and len(rows) > limit
        last = page[-1] if more and page else None
        next_cursor = (
            SessionCursor(
                int(last.pinned),
                cursor_time(last.sort_at or last.updated_at),
                last.last_item_order_seq if last.last_item_order_seq is not None else -1,
                last.sequence,
                last.id,
            ).encode()
            if last
            else None
        )
        items = [session_view(row, sources[row.connector_id]) for row in page]
        return {
            "sessions": items,
            "items": items,
            "hasMore": more,
            "nextCursor": next_cursor,
            "serverTime": datetime.now(UTC).isoformat(),
        }

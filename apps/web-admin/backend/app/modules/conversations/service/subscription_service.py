"""订阅快照使用当前授权与领域公开视图，协议控制器不直接查询持久层。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.modules.conversations.service.event_protocol import event_envelope
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


class SubscriptionService:
    """会话首帧、工作台完整快照和持续授权都使用同一个业务入口。"""

    def __init__(self, conversations: "ConversationService") -> None:
        self.conversations = conversations

    async def subscribed(
        self, account: Account, session_id: str, client_id: str
    ) -> dict[str, object]:
        """首帧公布当前持久游标，旧客户端通过HTTP按自身游标补齐断线历史。"""
        row = await self.conversations.own(account, session_id)
        return event_envelope(
            session_id,
            row.sequence,
            "session.subscribed",
            {"clientId": client_id, "eventCursor": f"seq:{row.sequence}"},
        )

    async def dashboard(self, account: Account) -> dict[str, object]:
        """分别检查读取权限；快照保留项目、会话、运行实例和分页信息。"""
        account.require("devices.read")
        conversations = self.conversations
        connectors = (await conversations.devices.listing(account))["connectors"]
        assert isinstance(connectors, list)
        projects = (
            (await conversations.projects.listing(account))["projects"]
            if ("projects.read" in account.permissions)
            else []
        )
        sessions: list[dict[str, object]] = []
        if "sessions.read" in account.permissions:
            await conversations.projection.sync(account)
            async with conversations.repository.transaction() as dao:
                rows = await dao.sessions(account.user_id)
            sessions = [await conversations.view(account, row) for row in rows]
        runtimes: list[object] = []
        for connector in connectors:
            assert isinstance(connector, dict)
            listing = await conversations.devices.runtimes.listing(account, str(connector["id"]))
            values = listing.get("runtimes")
            if isinstance(values, list):
                runtimes.extend(values)
        return {
            "type": "dashboard.snapshot",
            "connectors": connectors,
            "projects": projects,
            "sessions": sessions,
            "runtimes": runtimes,
            "sessionPages": {
                "active": {"hasMore": False, "nextCursor": None},
                "archived": {"hasMore": False, "nextCursor": None},
            },
            "serverTime": datetime.now(UTC).isoformat(),
        }

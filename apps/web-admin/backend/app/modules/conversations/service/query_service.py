"""工作台历史分页与断线恢复，只读取已提交事实，不触发第二条执行队列。"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.do.models import SessionRow
from app.modules.conversations.entity.vo.timeline_query import (
    TimelineQuery,
    event_cursor,
    query_integer,
)
from app.modules.conversations.service.event_protocol import event_envelope
from app.modules.conversations.service.views import effective_capabilities, runtime_state_view
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


def _is_revision(value: object) -> bool:
    try:
        return float(str(value or 1)) > 1
    except (ValueError, OverflowError):
        return False


@dataclass(frozen=True)
class TimelinePage:
    """同一提交边界下的条目与会话序列，避免游标越过尚未返回的消息。"""

    session: SessionRow
    items: list[dict[str, object]]
    has_more: bool

    def view(self) -> dict[str, object]:
        """nextSeq 是恢复位置；历史翻页须使用首条消息的 orderSeq。"""
        return {
            "sessionId": self.session.id,
            "items": self.items,
            "nextSeq": self.session.sequence,
            "hasMore": self.has_more,
            "serverTime": datetime.now(UTC).isoformat(),
        }


class ConversationQueryService:
    """HTTP 补偿读取与 WS 持久事件轮询分开，避免恢复重复状态导致流式游标倒退。"""

    def __init__(self, conversations: "ConversationService") -> None:
        self.conversations = conversations

    async def read(self, account: Account, identifier: str, query: TimelineQuery) -> TimelinePage:
        """与投影写入共用会话锁，授权、分页事实和返回序列在短事务内一致。"""
        async with self.conversations.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.session(identifier)
            if not row or row.owner_id != account.user_id or row.source.get("historyDeletedAt"):
                raise DomainError(404, "session not found")
            rows = await dao.timeline_items(
                identifier, query.mode, query.after, query.before, query.limit + 1
            )
            selected = rows[: query.limit]
            items = [
                {
                    **item.payload,
                    "id": item.item_id,
                    "orderSeq": item.order_seq,
                    "updatedSeq": item.sequence,
                }
                for item in selected
            ]
            if query.mode != "changes":
                items.reverse()
            return TimelinePage(row, items, len(rows) > query.limit)

    async def timeline(
        self, account: Account, identifier: str, query: Mapping[str, str]
    ) -> dict[str, object]:
        """最新、历史和变化模式共享查询实现，输入校验在资源授权之后执行。"""
        await self.conversations.own(account, identifier)
        await self.conversations.projection.sync(account)
        return (await self.read(account, identifier, TimelineQuery.parse(query))).view()

    @staticmethod
    def snapshot_required(sequence: int) -> dict[str, object]:
        """游标失效或变化超出请求上限时要求完整快照，不能悄悄跳过未返回事件。"""
        return {
            "events": [],
            "nextCursor": f"seq:{sequence}",
            "snapshotRequired": True,
            "serverTime": datetime.now(UTC).isoformat(),
        }

    async def recover(
        self, account: Account, identifier: str, query: Mapping[str, str]
    ) -> dict[str, object]:
        """重建当前变化和状态三件套，完整替换、溢出或并发变化改走快照。"""
        await self.conversations.own(account, identifier)
        await self.conversations.projection.sync(account)
        after = event_cursor(query)
        async with self.conversations.repository.transaction() as dao:
            await dao.lock(identifier)
            initial = await dao.session(identifier)
            if (
                not initial
                or initial.owner_id != account.user_id
                or initial.source.get("historyDeletedAt")
            ):
                raise DomainError(404, "session not found")
            reset = await dao.timeline_reset_sequence(identifier)
        if after > initial.sequence or after < reset:
            return self.snapshot_required(initial.sequence)
        limit = query_integer(query.get("limit"), 100, 1, 500)
        page = await self.read(account, identifier, TimelineQuery("changes", after, None, limit))
        if page.has_more:
            return self.snapshot_required(page.session.sequence)
        current = await self.conversations.own(account, identifier)
        if current.sequence != initial.sequence:
            return self.snapshot_required(current.sequence)
        events = [
            event_envelope(
                identifier,
                int(str(item["updatedSeq"])),
                "timeline.item_updated"
                if _is_revision(item.get("revision"))
                else "timeline.item_created",
                {"item": item},
            )
            for item in page.items
        ]
        if after <= current.sequence:
            session = await self.conversations.view(account, current)
            source = await self.conversations.runtime_capabilities(account, identifier)
            projections: tuple[tuple[str, dict[str, object]], ...] = (
                ("session.meta.updated", {"session": session}),
                (
                    "runtime.state.updated",
                    {"state": {**runtime_state_view(current), "updatedSeq": current.sequence}},
                ),
                (
                    "runtime.capability.updated",
                    {
                        "capabilitySet": effective_capabilities(
                            current, source, session.get("connectorStatus") == "online"
                        )
                    },
                ),
            )
            for kind, payload in projections:
                events.append(event_envelope(identifier, current.sequence, kind, payload))
        events.sort(key=lambda event: (int(str(event["sequence"])), str(event["eventId"])))
        return {
            "sessionId": identifier,
            "events": events,
            "nextCursor": f"seq:{page.session.sequence}",
            "snapshotRequired": False,
            "serverTime": datetime.now(UTC).isoformat(),
        }

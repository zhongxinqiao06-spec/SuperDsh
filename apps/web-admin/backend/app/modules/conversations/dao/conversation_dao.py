"""会话仓储只负责查询与变更，所有权和事件语义由用例决定。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import Integer, delete, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.conversations.entity.bo.session_cursor import SessionCursor
from app.modules.conversations.entity.do.models import (
    ConversationEventRow,
    ConversationReceiptRow,
    ConversationShareRow,
    ProjectionCursorRow,
    ProjectRow,
    SessionRow,
    TimelineRow,
    WebSocketTicketRow,
)


class ConversationDao:
    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def lock(self, identifier: str) -> None:
        await lock_transaction(self.db, "web-admin:conversation:" + identifier)

    async def project(self, identifier: str) -> ProjectRow | None:
        return await self.db.get(ProjectRow, identifier)

    async def projects(self, owner: str) -> list[ProjectRow]:
        return list(
            await self.db.scalars(
                select(ProjectRow)
                .where(ProjectRow.owner_id == owner)
                .order_by(ProjectRow.pinned.desc(), ProjectRow.updated_at.desc(), ProjectRow.id)
            )
        )

    async def session(self, identifier: str) -> SessionRow | None:
        return await self.db.get(SessionRow, identifier)

    async def sessions(self, owner: str | None = None) -> list[SessionRow]:
        query = select(SessionRow).where(
            SessionRow.source["historyDeletedAt"].as_string().is_(None)
        )
        if owner:
            query = query.where(SessionRow.owner_id == owner)
        return list(
            await self.db.scalars(
                query.order_by(
                    SessionRow.pinned.desc(),
                    func.coalesce(SessionRow.sort_at, SessionRow.created_at).desc(),
                    SessionRow.last_item_order_seq.desc().nulls_last(),
                    SessionRow.sequence.desc(),
                    SessionRow.id.desc(),
                )
            )
        )

    async def creation(self, owner: str, key: str) -> SessionRow | None:
        return await self.db.scalar(
            select(SessionRow).where(SessionRow.owner_id == owner, SessionRow.creation_key == key)
        )

    async def session_page(
        self,
        owner: str,
        connectors: list[str],
        filters: dict[str, str],
        cursor: SessionCursor | None,
        limit: int | None,
        inventory: bool,
    ) -> list[SessionRow]:
        """数据库按完整键集翻页；撤销设备从授权源集合剔除，不在分页后过滤。"""
        query = select(SessionRow).where(
            SessionRow.owner_id == owner,
            SessionRow.connector_id.in_(connectors),
            SessionRow.source["historyDeletedAt"].as_string().is_(None),
        )
        if not inventory:
            query = query.where(SessionRow.archived.is_(filters.get("archived") == "true"))
        for key, column in (
            ("projectId", SessionRow.project_id),
            ("connectorId", SessionRow.connector_id),
        ):
            if filters.get(key):
                query = query.where(column == filters[key])
        search = filters.get("q", filters.get("search", ""))
        if search:
            query = query.where(SessionRow.title.icontains(search, autoescape=True))
        # 旧SQL时间列为UTC ISO文本；明确格式化避免数据库区域设置改变游标比较规则。
        sort_at = func.to_char(
            func.timezone("UTC", func.coalesce(SessionRow.sort_at, SessionRow.updated_at)),
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"',
        )
        keys = (
            SessionRow.pinned.cast(Integer),
            sort_at,
            func.coalesce(SessionRow.last_item_order_seq, -1),
            SessionRow.sequence,
            SessionRow.id,
        )
        if cursor:
            query = query.where(
                tuple_(*keys)
                < tuple_(
                    cursor.pinned,
                    cursor.sort_at,
                    cursor.item_order,
                    cursor.sequence,
                    cursor.identifier,
                )
            )
        query = query.order_by(*(key.desc() for key in keys))
        if limit is not None:
            query = query.limit(limit + 1)
        return list(await self.db.scalars(query))

    async def scoped_sessions(self, owner: str, target: str, project: bool) -> list[SessionRow]:
        """批量用例读取完整归属集合，不复用有上限的页面查询。"""
        field = SessionRow.project_id if project else SessionRow.connector_id
        return list(
            await self.db.scalars(
                select(SessionRow)
                .where(
                    SessionRow.owner_id == owner,
                    field == target,
                    SessionRow.source["historyDeletedAt"].as_string().is_(None),
                )
                .order_by(SessionRow.id)
            )
        )

    async def refresh_session(self, row: SessionRow) -> None:
        """取得批量锁后刷新实体，避免等待期间的旧版本覆盖并发投影。"""
        await self.db.refresh(row)

    async def item(self, session: str, identifier: str) -> TimelineRow | None:
        return await self.db.get(TimelineRow, (session, identifier))

    async def latest_item(self, session: str) -> TimelineRow | None:
        """最后消息按真实发生时间、稳定顺序选择，不能以最近元数据事件代替。"""
        return await self.db.scalar(
            select(TimelineRow)
            .where(TimelineRow.session_id == session)
            .order_by(TimelineRow.item_time.desc(), TimelineRow.order_seq.desc())
            .limit(1)
        )

    async def snapshot_items(self, session: str) -> list[TimelineRow]:
        """分享快照使用完整有序事实，不能复用工作台分页而静默截断历史。"""
        return list(
            await self.db.scalars(
                select(TimelineRow)
                .where(TimelineRow.session_id == session)
                .order_by(TimelineRow.order_seq, TimelineRow.item_id)
            )
        )

    async def message_facts(self) -> list[dict[str, object]]:
        """仅查询用户发起消息的统计元数据，不读取正文、不截断历史数量。"""
        payload = TimelineRow.payload
        query = (
            select(
                SessionRow.owner_id,
                SessionRow.id,
                SessionRow.runtime_type,
                payload["createdAt"].as_string(),
                payload["timestamp"].as_string(),
                payload["itemTime"].as_string(),
            )
            .join(SessionRow, SessionRow.id == TimelineRow.session_id)
            .where(
                payload["type"].as_string() == "message",
                payload["role"].as_string() == "user",
                payload["clientMessageId"].as_string().is_not(None),
            )
        )
        rows = await self.db.execute(query)
        return [
            {
                "userId": row[0],
                "sessionId": row[1],
                "agentType": row[2],
                "createdAt": row[3] or row[4] or row[5],
            }
            for row in rows
        ]

    async def items(
        self, session: str, before: int | None = None, limit: int = 200
    ) -> list[TimelineRow]:
        query = select(TimelineRow).where(TimelineRow.session_id == session)
        if before is not None:
            query = query.where(TimelineRow.order_seq < before)
        return list(
            reversed(
                list(
                    await self.db.scalars(
                        query.order_by(
                            TimelineRow.order_seq.desc(), TimelineRow.item_id.desc()
                        ).limit(limit)
                    )
                )
            )
        )

    async def replace_items(self, session: str, retained: list[str]) -> bool:
        """返回真实删除事实，重复完整快照不能仅因收到 complete 就重置客户端。"""
        result = await self.db.execute(
            delete(TimelineRow)
            .where(TimelineRow.session_id == session, TimelineRow.item_id.not_in(retained))
            .returning(TimelineRow.item_id)
        )
        return result.first() is not None

    async def clear_history(self, identifier: str) -> None:
        """清除平台展示历史，保留会话墓碑与执行收据，防止同步复活或旧请求重放。"""
        for table in (TimelineRow, ConversationEventRow, ConversationShareRow):
            await self.db.execute(delete(table).where(table.session_id == identifier))

    async def timeline_items(
        self, session: str, mode: str, after: int, before: int | None, limit: int
    ) -> list[TimelineRow]:
        """变化页按最后修改序列升序，历史与最新页按稳定展示顺序倒序读取。"""
        query = select(TimelineRow).where(TimelineRow.session_id == session)
        if mode == "changes":
            query = query.where(TimelineRow.sequence > after).order_by(
                TimelineRow.sequence, TimelineRow.item_id
            )
        else:
            if mode == "history" and before is not None:
                query = query.where(TimelineRow.order_seq < before)
            query = query.order_by(TimelineRow.order_seq.desc(), TimelineRow.item_id.desc())
        return list(await self.db.scalars(query.limit(limit)))

    async def timeline_reset_sequence(self, session: str) -> int:
        """完整替换后的旧游标不能继续增量恢复；重置事件与替换在同一事务提交。"""
        return int(
            await self.db.scalar(
                select(func.max(ConversationEventRow.sequence)).where(
                    ConversationEventRow.session_id == session,
                    ConversationEventRow.type == "session.refetch_required",
                )
            )
            or 0
        )

    async def events(
        self, session: str, after: int, limit: int = 200
    ) -> list[ConversationEventRow]:
        return list(
            await self.db.scalars(
                select(ConversationEventRow)
                .where(
                    ConversationEventRow.session_id == session,
                    ConversationEventRow.sequence > after,
                )
                .order_by(ConversationEventRow.sequence)
                .limit(limit)
            )
        )

    async def receipt(self, session: str, operation: str) -> ConversationReceiptRow | None:
        return await self.db.get(ConversationReceiptRow, (session, operation))

    async def cursor(self, owner: str) -> ProjectionCursorRow | None:
        return await self.db.get(ProjectionCursorRow, owner)

    async def share(self, identifier: str) -> ConversationShareRow | None:
        return await self.db.get(ConversationShareRow, identifier)

    async def shares(self, owner: str, session: str) -> list[ConversationShareRow]:
        """仅检索指定所有者会话的分享记录，权限由调用服务校验。"""
        return list(
            await self.db.scalars(
                select(ConversationShareRow)
                .where(
                    ConversationShareRow.owner_id == owner,
                    ConversationShareRow.session_id == session,
                )
                .order_by(ConversationShareRow.created_at.desc())
            )
        )

    async def ticket(self, digest: str) -> WebSocketTicketRow | None:
        return await self.db.get(WebSocketTicketRow, digest)

    async def save(
        self,
        row: ProjectRow
        | SessionRow
        | TimelineRow
        | ConversationEventRow
        | ConversationReceiptRow
        | ProjectionCursorRow
        | ConversationShareRow
        | WebSocketTicketRow,
    ) -> None:
        self.db.add(row)
        await self.db.flush()

    async def remove(
        self, row: ProjectRow | ConversationShareRow | WebSocketTicketRow | ConversationReceiptRow
    ) -> None:
        await self.db.delete(row)


class ConversationRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[ConversationDao]:
        async with self.database.sessions.begin() as session:
            yield ConversationDao(session)

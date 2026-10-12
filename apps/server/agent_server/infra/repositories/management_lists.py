"""Database-backed management lists; legacy unpaged clients retain their shape."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.engine import RowMapping
from sqlalchemy.sql import Select

from agent_server.core.utc import utc_now
from agent_server.infra.db.identity_schema import auth_sessions, identity_audit
from agent_server.infra.db.schema import connectors, users


def search_query(query: Select, search: str, *columns: Any) -> Select:
    value = search.strip().lower()
    if not value:
        return query
    return query.where(
        or_(
            *(func.lower(column).contains(value, autoescape=True) for column in columns)
        )
    )


class ManagementListRepositoryMixin:
    async def _management_rows(
        self,
        query: Select,
        *,
        page: int | None,
        page_size: int | None,
        legacy_limit: int | None = None,
    ) -> tuple[list[RowMapping], dict[str, int]]:
        current_page = max(1, page or 1)
        limit = (
            max(1, min(200, 25 if page_size is None else page_size))
            if page is not None or page_size is not None
            else legacy_limit
        )
        async with self._engine.connect() as conn:
            total = int(
                await conn.scalar(
                    select(func.count()).select_from(query.order_by(None).subquery())
                )
                or 0
            )
            if limit is not None:
                query = query.offset((current_page - 1) * limit).limit(limit)
            rows = list((await conn.execute(query)).mappings().all())
        return rows, {
            "total": total,
            "page": current_page,
            "pageSize": limit if limit is not None else max(1, total),
        }

    async def management_users(
        self, *, page: int = 1, page_size: int = 50, search: str = ""
    ) -> dict:
        query = search_query(
            select(users), search, users.c.username, users.c.email, users.c.display_name
        ).order_by(users.c.created_at, users.c.id)
        rows, metadata = await self._management_rows(
            query, page=page, page_size=page_size
        )
        async with self._engine.connect() as conn:
            entries = [await self._user_with_grants(conn, row) for row in rows]
        return {"users": entries, **metadata}

    async def management_devices(
        self,
        *,
        page: int | None = None,
        page_size: int | None = None,
        search: str = "",
    ) -> dict:
        # This projection is deliberately operational only: no keys, paths or content.
        query = select(
            connectors.c.id,
            connectors.c.name,
            connectors.c.user_id,
            users.c.username,
            connectors.c.connector_kind,
            connectors.c.executor_kind,
            connectors.c.device_os,
            connectors.c.connector_version,
            connectors.c.status,
            connectors.c.last_seen_at,
            connectors.c.connection_blocked_at,
            connectors.c.connection_blocked_reason,
        ).select_from(connectors.outerjoin(users, connectors.c.user_id == users.c.id))
        query = search_query(
            query.where(connectors.c.revoked == 0),
            search,
            connectors.c.name,
            connectors.c.id,
            connectors.c.user_id,
            users.c.username,
            connectors.c.device_os,
        ).order_by(connectors.c.updated_at.desc(), connectors.c.id)
        rows, metadata = await self._management_rows(
            query, page=page, page_size=page_size
        )
        return {
            "devices": [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "userId": row["user_id"],
                    "username": row["username"],
                    "connectorKind": row["connector_kind"],
                    "executorKind": row["executor_kind"],
                    "deviceOs": row["device_os"],
                    "version": row["connector_version"],
                    "status": row["status"],
                    "lastSeenAt": row["last_seen_at"],
                    "blockedAt": row["connection_blocked_at"],
                    "blockedReason": row["connection_blocked_reason"],
                }
                for row in rows
            ],
            **metadata,
        }

    async def management_audit(
        self,
        *,
        page: int | None = None,
        page_size: int | None = None,
        search: str = "",
    ) -> dict:
        query = search_query(
            select(identity_audit),
            search,
            identity_audit.c.action,
            identity_audit.c.actor_id,
            identity_audit.c.target_id,
        ).order_by(identity_audit.c.created_at.desc(), identity_audit.c.id)
        rows, metadata = await self._management_rows(
            query, page=page, page_size=page_size, legacy_limit=200
        )
        return {
            "events": [
                {
                    "id": row["id"],
                    "actorId": row["actor_id"],
                    "action": row["action"],
                    "targetId": row["target_id"],
                    "createdAt": row["created_at"],
                    "detail": json.loads(row["detail_json"]),
                }
                for row in rows
            ],
            **metadata,
        }

    async def management_login_sessions(
        self,
        user_id: str,
        current_sid: str | None,
        *,
        page: int | None = None,
        page_size: int | None = None,
        search: str = "",
    ) -> dict:
        query = select(
            auth_sessions.c.id,
            auth_sessions.c.client_name,
            auth_sessions.c.created_at,
            auth_sessions.c.last_seen_at,
            auth_sessions.c.expires_at,
        ).where(
            auth_sessions.c.user_id == user_id,
            auth_sessions.c.revoked_at.is_(None),
            auth_sessions.c.expires_at > utc_now(),
        )
        query = search_query(query, search, auth_sessions.c.client_name).order_by(
            auth_sessions.c.created_at.desc(), auth_sessions.c.id
        )
        rows, metadata = await self._management_rows(
            query, page=page, page_size=page_size
        )
        return {
            "sessions": [
                {
                    "id": row["id"],
                    "clientName": row["client_name"],
                    "createdAt": row["created_at"],
                    "lastSeenAt": row["last_seen_at"],
                    "expiresAt": row["expires_at"],
                    "current": row["id"] == current_sid,
                }
                for row in rows
            ],
            **metadata,
        }

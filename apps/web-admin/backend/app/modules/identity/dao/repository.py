"""SQLAlchemy 仓储将 ORM 记录映射为纯实体，事务外不泄漏会话。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import String, cast, func, or_, select, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.identity.entity.bo.models import LoginSession, Role, User
from app.modules.identity.entity.do.models import AuditRow, RoleRow, SessionRow, UserRow
from app.modules.identity.service.ports import IdentityTransaction


def user_entity(row: UserRow) -> User:
    return User(**{name: getattr(row, name) for name in User.__dataclass_fields__})


class SqlIdentityTransaction:
    """应用用例使用的短事务仓储；写入与审计在同次提交。"""

    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def lock(self) -> None:
        await lock_transaction(self.db, "web-admin:identity-management")

    async def users(self) -> list[User]:
        rows = await self.db.scalars(
            select(UserRow)
            .where(UserRow.erased.is_(False))
            .order_by(UserRow.created_at, UserRow.id)
        )
        return [user_entity(row) for row in rows]

    async def product_members(
        self, role_ids: list[str], search: str, offset: int, size: int
    ) -> tuple[list[User], int]:
        """分页和计数共用同一产品成员条件，先按角色过滤再搜索，不加载全平台账号。"""
        matching = UserRow.roles.has_any(cast(role_ids, ARRAY(String())))
        query = select(UserRow).where(matching, UserRow.deleted_at.is_(None))
        if search:
            query = query.where(
                or_(
                    UserRow.username.icontains(search, autoescape=True),
                    UserRow.display_name.icontains(search, autoescape=True),
                )
            )
        count = await self.db.scalar(select(func.count()).select_from(query.subquery()))
        rows = await self.db.scalars(
            query.order_by(UserRow.username, UserRow.id).offset(offset).limit(size)
        )
        return [user_entity(row) for row in rows], int(count or 0)

    async def user(self, user_id: str) -> User | None:
        row = await self.db.get(UserRow, user_id)
        return user_entity(row) if row and not row.erased else None

    async def find_user(self, identifier: str) -> User | None:
        row = await self.db.scalar(
            select(UserRow).where(or_(UserRow.username == identifier, UserRow.email == identifier))
        )
        return user_entity(row) if row and not row.erased else None

    async def save_user(self, user: User) -> None:
        user.updated_at = datetime.now(UTC)
        await self.db.merge(UserRow(**asdict(user)))
        await self.db.flush()

    async def roles(self) -> list[Role]:
        rows = await self.db.scalars(select(RoleRow).order_by(RoleRow.id))
        return [
            Role(**{name: getattr(row, name) for name in Role.__dataclass_fields__}) for row in rows
        ]

    async def save_role(self, role: Role) -> None:
        await self.db.merge(RoleRow(**asdict(role)))
        await self.db.flush()

    async def delete_role(self, role_id: str) -> None:
        row = await self.db.get(RoleRow, role_id)
        if row:
            await self.db.delete(row)

    async def session(self, session_id: str, *, lock: bool = False) -> LoginSession | None:
        statement = select(SessionRow).where(SessionRow.id == session_id)
        if lock:
            statement = statement.with_for_update()
        row = await self.db.scalar(statement)
        return (
            LoginSession(**{name: getattr(row, name) for name in LoginSession.__dataclass_fields__})
            if row
            else None
        )

    async def sessions(self, user_id: str) -> list[LoginSession]:
        rows = await self.db.scalars(
            select(SessionRow)
            .where(SessionRow.user_id == user_id)
            .order_by(SessionRow.created_at.desc(), SessionRow.id)
        )
        return [
            LoginSession(**{name: getattr(row, name) for name in LoginSession.__dataclass_fields__})
            for row in rows
        ]

    async def save_session(self, session: LoginSession) -> None:
        await self.db.merge(SessionRow(**asdict(session)))
        await self.db.flush()

    async def touch_session(self, session_id: str, now: datetime) -> None:
        """只更新活跃时间，不能用旧实体覆盖并发刷新或撤销字段。"""
        await self.db.execute(
            update(SessionRow)
            .where(SessionRow.id == session_id, SessionRow.revoked_at.is_(None))
            .values(last_seen_at=now)
        )

    async def audit(
        self, actor: str | None, action: str, target: str, detail: dict[str, object]
    ) -> None:
        self.db.add(
            AuditRow(
                id=str(uuid4()),
                actor_id=actor,
                action=action,
                target_id=target,
                detail=detail,
                created_at=datetime.now(UTC),
            )
        )


class SqlIdentityRepository:
    """通过端口注入身份用例；异常和取消自动回滚并释放连接。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[IdentityTransaction]:
        async with self.database.sessions.begin() as session:
            yield SqlIdentityTransaction(session)

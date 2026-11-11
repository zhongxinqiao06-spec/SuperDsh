"""账户扩展仓储：数据库语句与实体映射集中在本领域，事务由 service 决定。"""

from datetime import datetime

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.infrastructure.database import Database
from app.modules.identity.entity.do.account_models import (
    ExternalOAuthBindingRow,
    ExternalOAuthStateRow,
    MobileGrantRow,
    RecoveryCodeRow,
    VerificationCodeRow,
    VerificationLimitRow,
)
from app.modules.identity.entity.do.models import AuditRow, SessionRow, UserRow


class SqlAccountRepository:
    """提供身份扩展事务所需的查询，不自行提交、授权或调用其他领域。"""

    def __init__(self, database: Database) -> None:
        self.sessions = database.sessions

    async def user(
        self, session: AsyncSession, identifier: str, *, by_id: bool = False
    ) -> UserRow | None:
        condition = (
            UserRow.id == identifier
            if by_id
            else or_(UserRow.username == identifier, UserRow.email == identifier)
        )
        return await session.scalar(select(UserRow).where(condition))

    async def recovery(self, session: AsyncSession, code_hash: str) -> RecoveryCodeRow | None:
        return await session.scalar(
            select(RecoveryCodeRow).where(RecoveryCodeRow.code_hash == code_hash).with_for_update()
        )

    async def replace_recovery(
        self, session: AsyncSession, user_id: str, values: list[RecoveryCodeRow]
    ) -> None:
        await session.execute(delete(RecoveryCodeRow).where(RecoveryCodeRow.user_id == user_id))
        session.add_all(values)

    async def code(self, session: AsyncSession, scope: str) -> VerificationCodeRow | None:
        return await session.get(VerificationCodeRow, scope, with_for_update=True)

    async def email_limit(self, session: AsyncSession, key: str) -> VerificationLimitRow | None:
        return await session.get(VerificationLimitRow, key, with_for_update=True)

    async def mobile(self, session: AsyncSession, token_hash: str) -> MobileGrantRow | None:
        return await session.get(MobileGrantRow, token_hash, with_for_update=True)

    async def oauth_state(
        self, session: AsyncSession, token_hash: str
    ) -> ExternalOAuthStateRow | None:
        return await session.get(ExternalOAuthStateRow, token_hash, with_for_update=True)

    async def oauth_binding(
        self, session: AsyncSession, key: str
    ) -> ExternalOAuthBindingRow | None:
        return await session.get(ExternalOAuthBindingRow, key)

    async def revoke_sessions(self, session: AsyncSession, user_id: str, now: datetime) -> None:
        for value in await session.scalars(select(SessionRow).where(SessionRow.user_id == user_id)):
            value.revoked_at = now

    async def audit(self, session: AsyncSession, row: AuditRow) -> None:
        session.add(row)

    async def audit_page(
        self, session: AsyncSession, page: int, size: int, search: str, action: str
    ) -> tuple[list[tuple[AuditRow, str | None]], int]:
        condition: list[ColumnElement[bool]] = [
            AuditRow.action.ilike(f"%{search}%")
            | AuditRow.target_id.ilike(f"%{search}%")
            | AuditRow.actor_id.ilike(f"%{search}%")
        ]
        if action:
            condition.append(AuditRow.action == action)
        total = await session.scalar(select(func.count()).select_from(AuditRow).where(*condition))
        rows = await session.execute(
            select(AuditRow, UserRow.username)
            .outerjoin(UserRow, UserRow.id == AuditRow.actor_id)
            .where(*condition)
            .order_by(AuditRow.created_at.desc(), AuditRow.id)
            .offset((page - 1) * size)
            .limit(size)
        )
        return [(record[0], record[1]) for record in rows], int(total or 0)

    async def facts(
        self, session: AsyncSession, before: datetime
    ) -> tuple[list[UserRow], list[SessionRow]]:
        users = list(await session.scalars(select(UserRow)))
        logins = list(
            await session.scalars(select(SessionRow).where(SessionRow.created_at < before))
        )
        return users, logins

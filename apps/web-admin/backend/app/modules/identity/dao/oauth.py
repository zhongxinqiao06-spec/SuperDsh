"""OAuth DAO 仅负责行锁与授权码记录映射。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database
from app.modules.identity.entity.bo.oauth import OAuthGrant
from app.modules.identity.entity.do.models import OAuthCodeRow
from app.modules.identity.service.ports import OAuthTransaction


class SqlOAuthTransaction:
    """用例控制事务提交，授权和过期校验在服务完成。"""

    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def save(self, grant: OAuthGrant) -> None:
        await self.db.merge(OAuthCodeRow(**asdict(grant)))

    async def read(self, code_hash: str, lock: bool = False) -> OAuthGrant | None:
        query = select(OAuthCodeRow).where(OAuthCodeRow.code_hash == code_hash)
        if lock:
            query = query.with_for_update()
        row = await self.db.scalar(query)
        return (
            OAuthGrant(**{name: getattr(row, name) for name in OAuthGrant.__dataclass_fields__})
            if row
            else None
        )


class SqlOAuthRepository:
    """OAuth 事务工厂，不执行认证或 HTTP 逻辑。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[OAuthTransaction]:
        async with self.database.sessions.begin() as session:
            yield SqlOAuthTransaction(session)

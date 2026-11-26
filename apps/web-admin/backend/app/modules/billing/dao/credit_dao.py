"""注册入账写入同一调用方事务，依次落实外键依赖。"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow, WalletRow


async def insert_registration_credit(
    session: AsyncSession, user_id: str, points: int, now: datetime, expires_at: datetime
) -> None:
    """新账号的钱包、注册批次和原始流水共享一个稳定来源键。"""
    source_key = "registration"
    lot_id = str(uuid4())
    await session.execute(insert(WalletRow).values(user_id=user_id, created_at=now))
    await session.execute(
        insert(CreditLotRow).values(
            id=lot_id,
            user_id=user_id,
            source_key=source_key,
            granted=points,
            remaining=points,
            held=0,
            created_at=now,
            expires_at=expires_at,
        )
    )
    await session.execute(
        insert(LedgerEntryRow).values(
            id=str(uuid4()),
            user_id=user_id,
            lot_id=lot_id,
            kind="registration_grant",
            event_key=source_key,
            available_delta=points,
            held_delta=0,
            created_at=now,
        )
    )

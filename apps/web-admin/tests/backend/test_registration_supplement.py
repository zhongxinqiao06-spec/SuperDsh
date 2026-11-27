"""存量 40 点账号补发一次，不改变消耗、占用或已发的 200 点。"""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import upgrade_database
from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.billing.entity.do.credit_do import CreditLotRow, LedgerEntryRow
from app.modules.identity.entity.do.models import UserRow


@pytest.mark.parametrize("platform_configuration", ["0ac3d98e62a4"], indirect=True)
async def test_registration_supplement_preserves_spending(
    platform_configuration: Settings,
) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine)
    now = datetime.now(UTC)
    try:
        async with sessions.begin() as db:
            for uid, points in [("old", 40), ("current", 200), ("deleted", 40)]:
                await db.execute(
                    insert(UserRow).values(
                        id=uid,
                        username=uid,
                        password_hash="fixture",
                        roles=["member"],
                        deleted_at=now if uid == "deleted" else None,
                    )
                )
                # 历史修订还没有卡种表和快照列，按当时的三项账本结构布置数据。
                args = {
                    "uid": uid,
                    "points": points,
                    "issued": now - timedelta(days=40),
                    "expiry": now - timedelta(days=10),
                }
                await db.execute(
                    text("INSERT INTO billing_wallets(user_id,created_at) VALUES (:uid,:issued)"),
                    args,
                )
                await db.execute(
                    text("""INSERT INTO billing_credit_lots
                    (id,user_id,source_key,granted,remaining,held,created_at,expires_at)
                    VALUES (:uid,:uid,'registration',:points,:points,0,:issued,:expiry)"""),
                    args,
                )
                await db.execute(
                    text("""INSERT INTO billing_ledger_entries
                    (id,user_id,lot_id,kind,event_key,available_delta,held_delta,created_at)
                    VALUES (:uid,:uid,:uid,'registration_grant','registration',:points,0,:issued)"""),
                    args,
                )
            await db.execute(
                update(CreditLotRow)
                .where(CreditLotRow.user_id == "old")
                .values(remaining=25, held=5)
            )
        await upgrade_database(url)
        await upgrade_database(url)
        async with sessions() as db:
            lots = (
                await db.scalars(
                    select(CreditLotRow).where(CreditLotRow.source_key == "registration_supplement")
                )
            ).all()
            assert len(lots) == 1 and lots[0].user_id == "old"
            assert (lots[0].granted, lots[0].remaining, lots[0].held) == (160, 160, 0)
            assert lots[0].expires_at - lots[0].created_at == timedelta(days=30)
            entries = (
                await db.scalars(select(LedgerEntryRow).where(LedgerEntryRow.lot_id == lots[0].id))
            ).all()
            assert len(entries) == 1 and entries[0].available_delta == 160
            old = (
                await db.scalars(
                    select(CreditLotRow).where(
                        CreditLotRow.source_key == "registration",
                        CreditLotRow.user_id == "old",
                    )
                )
            ).one()
            assert (old.granted, old.remaining, old.held) == (40, 25, 5)
    finally:
        await engine.dispose()

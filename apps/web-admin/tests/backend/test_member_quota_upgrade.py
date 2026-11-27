"""从生产上一版升级，保留历史扣点和在途预留，只升级未到期的已购权益。"""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import upgrade_database
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.identity.entity.do.models import UserRow


@pytest.mark.parametrize("platform_configuration", ["0bd3ec17af54"], indirect=True)
async def test_existing_period_preserves_usage(
    platform_configuration: Settings,
) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    now = datetime.now(UTC)
    data = dict(
        start=now - timedelta(days=9),
        end=now + timedelta(days=21),
        used=now - timedelta(days=8),
        held=now - timedelta(hours=1),
    )
    try:
        async with engine.begin() as db:
            await db.execute(
                insert(UserRow).values(
                    id="old", username="old", roles=["member"], password_hash="fixture"
                )
            )
            for sql in [
                "INSERT INTO billing_wallets VALUES ('old',:start)",
                """INSERT INTO billing_credit_lots(id,user_id,source_key,granted,remaining,held,created_at,expires_at)
                VALUES ('oldlot','old','membership_grant:oldop',300,230,20,:start,:end)""",
                """INSERT INTO billing_operations(id,user_id,actor_id,business_key,request,quote,created_at,confirmed_at)
                VALUES ('oldop','old','old','op','{}','{}',:start,:start)""",
                """INSERT INTO billing_periods(operation_id,user_id,plan_version_id,lot_id,starts_at,ends_at)
                VALUES ('oldop','old','light-1','oldlot',:start,:end)""",
                """INSERT INTO billing_ledger_entries(id,user_id,lot_id,event_key,kind,available_delta,held_delta,created_at) VALUES
                ('a','old','oldlot','membership_grant:oldop','membership_grant',300,0,:start),
                ('b','old','oldlot','reserve:oldjob','usage_hold',-70,70,:used),
                ('c','old','oldlot','finish:oldjob','usage_charge',0,-70,:used),
                ('d','old','oldlot','reserve:active','usage_hold',-20,20,:held)""",
            ]:
                await db.execute(text(sql), data)
        await upgrade_database(url)
        await upgrade_database(url)
        async with engine.connect() as db:
            row = (
                await db.execute(
                    text("""SELECT granted,remaining,held,q.weekly_remaining,q.monthly_remaining,
                 billing_spendable(l,now()) FROM billing_credit_lots l CROSS JOIN LATERAL billing_member_quota(l,now()) q
                 WHERE l.id='oldlot'""")
                )
            ).one()
            assert tuple(row) == (500, 430, 20, 180, 410, 180)
            assert (
                await db.scalar(
                    text(
                        "SELECT sum(available_delta) FROM billing_ledger_entries WHERE kind='member_quota_upgrade'"
                    )
                )
                == 200
            )
            assert (
                await db.scalar(
                    text("SELECT count(*) FROM billing_ledger_entries WHERE kind='usage_charge'")
                )
                == 1
            )
    finally:
        await engine.dispose()

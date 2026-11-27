"""钱包、办理预览及任务预留共用数据库计算的当期可用金额。"""

from datetime import datetime
from typing import cast

from sqlalchemy import Integer, Table, func, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.modules.billing.entity.do.credit_do import CreditLotRow
from app.modules.billing.entity.vo.dto import MemberQuota


def spendable(now: datetime) -> ColumnElement[int]:
    return func.billing_spendable(
        cast(Table, CreditLotRow.__table__).table_valued(), now, type_=Integer()
    )


async def current_quota(db: AsyncSession, owner: str, now: datetime) -> MemberQuota | None:
    row = (
        (
            await db.execute(
                text("""SELECT l.weekly_limit,l.monthly_limit,q.*
        FROM billing_credit_lots l CROSS JOIN LATERAL billing_member_quota(l,:now) q
        WHERE l.user_id=:owner AND l.weekly_limit IS NOT NULL AND l.created_at<=:now AND l.expires_at>:now
        ORDER BY l.created_at DESC LIMIT 1"""),
                {"owner": owner, "now": now},
            )
        )
        .mappings()
        .first()
    )
    return MemberQuota.model_validate(dict(row)) if row else None

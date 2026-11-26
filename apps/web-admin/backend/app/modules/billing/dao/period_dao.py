"""周期与账本的统一有效时间窗口；未来发放在数据库中预排，跨进程无需定时器。"""

from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.sql.elements import ColumnElement

from app.modules.billing.entity.do.credit_do import CreditLotRow
from app.modules.billing.entity.do.operation_do import BillingPeriodRow
from app.modules.billing.entity.do.plan_do import SubscriptionRow


def effective_plan(now: datetime | None = None) -> ColumnElement[str]:
    """显示当前这段会员最近已生效的版本，到期后历史列表继续保留末期档位。"""
    p = BillingPeriodRow
    current = (
        select(p.plan_version_id)
        .where(
            p.user_id == SubscriptionRow.user_id,
            p.starts_at >= SubscriptionRow.starts_at,
            p.starts_at < SubscriptionRow.ends_at,
        )
        .order_by(p.starts_at.desc())
        .limit(1)
        .correlate(SubscriptionRow)
    )
    if now is not None:
        current = current.where(p.starts_at <= now)
    return func.coalesce(current.scalar_subquery(), SubscriptionRow.plan_version_id)


def next_grant(owner: str, now: datetime) -> Select[datetime]:
    return select(func.min(BillingPeriodRow.starts_at)).where(
        BillingPeriodRow.user_id == owner, BillingPeriodRow.starts_at > now
    )


def available_totals(now: datetime) -> Select[str, int]:
    lot = CreditLotRow
    return (
        select(lot.user_id, func.sum(lot.remaining - lot.held).label("available"))
        .where(lot.created_at <= now, lot.expires_at > now)
        .group_by(lot.user_id)
    )

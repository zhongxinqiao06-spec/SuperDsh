"""邮箱验真注册权益，发放规则在这里统一维护。"""

from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.billing.dao.credit_dao import insert_registration_credit

REGISTRATION_POINTS = 40
REGISTRATION_TERM_DAYS = 30


async def grant_registration_credit(session: AsyncSession, user_id: str, now: datetime) -> None:
    """仅用于刚插入并验证的公开注册账号，失败随建号事务整体回滚。"""
    await insert_registration_credit(
        session, user_id, REGISTRATION_POINTS, now, now + timedelta(days=REGISTRATION_TERM_DAYS)
    )

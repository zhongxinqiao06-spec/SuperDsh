"""邮箱验真注册权益，发放规则在这里统一维护。"""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database
from app.modules.billing.dao import credit_dao
from app.modules.billing.entity.vo.registration_card import RegistrationCardNotice
from app.modules.identity.entity.bo.models import Account

REGISTRATION_POINTS = 200
REGISTRATION_TERM_DAYS = 30


async def grant_registration_credit(
    session: AsyncSession, user_id: str, now: datetime
) -> dict[str, object]:
    """仅用于刚插入并验证的公开注册账号，失败随建号事务整体回滚。"""
    expires_at = now + timedelta(days=REGISTRATION_TERM_DAYS)
    await credit_dao.insert_registration_credit(
        session, user_id, REGISTRATION_POINTS, now, expires_at
    )
    return {"points": REGISTRATION_POINTS, "expiresAt": expires_at.isoformat()}


class RegistrationNotices:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def unread(self, actor: Account) -> RegistrationCardNotice | None:
        """读取不会标记已读；即使注册后直接关闭网页，下次进入仍能看到。"""
        async with self.database.sessions() as session:
            card = await credit_dao.unread_registration_card(session, actor.user_id)
            if card is None:
                return None
            return RegistrationCardNotice(
                id=card.id,
                name=card.card_name or "场记卡",
                image=card.card_image or "/images/credit-cards/slate.webp",
                points=card.granted,
                expires_at=card.expires_at,
            )

    async def acknowledge(self, actor: Account, lot_id: str) -> None:
        async with self.database.sessions.begin() as session:
            await credit_dao.acknowledge_registration_card(
                session, actor.user_id, lot_id, datetime.now(UTC)
            )

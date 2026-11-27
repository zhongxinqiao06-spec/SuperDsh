"""个人账户账务查询规则，共享同一用户身份和一套账本。"""

from datetime import UTC, datetime

from app.infrastructure.errors import DomainError
from app.modules.billing.dao.card_dao import types as card_types
from app.modules.billing.dao.membership_dao import MembershipRepository
from app.modules.billing.dao.pricing_dao import active
from app.modules.billing.entity.vo.dto import Catalog, CreditCards, Entries, EntryDetail, Wallet
from app.modules.billing.entity.vo.pricing import RateTerms, UsageItem
from app.modules.billing.service.quote_service import price
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import UNLIMITED_CREDIT_ROLES


class MembershipService:
    def __init__(self, repository: MembershipRepository) -> None:
        self.repository = repository

    @staticmethod
    def owner(account: Account) -> str:
        if account.reset_required:
            raise DomainError(403, "password change required")
        return account.user_id

    async def catalog(self, account: Account) -> Catalog:
        self.owner(account)
        now = datetime.now(UTC)
        example = UsageItem(
            product="entertainment",
            capability="video.generate",
            model="*",
            spec="720P",
            payer="platform",
            quantity=5,
        )
        async with self.repository.database.sessions() as db:
            cards = await card_types(db, True)
            row = await active(db, example, now)
        rate = RateTerms.model_validate(row.payload["terms"]) if row else None
        return Catalog(
            card_types=cards,
            card_denominations=sorted({c.points for c in cards}),
            items=await self.repository.plans(now),
            sale_open=False,
            sample_points_per_second=price(example.model_copy(update={"quantity": 1}), rate)[
                "points"
            ]
            if rate
            else 0,
            sample_clip_points=price(example, rate)["points"] if rate else None,
        )

    async def wallet(self, account: Account) -> Wallet:
        wallet = await self.repository.wallet(self.owner(account), datetime.now(UTC), 7, 20)
        wallet.unlimited = not UNLIMITED_CREDIT_ROLES.isdisjoint(account.roles)
        return wallet

    async def cards(self, account: Account, page: int, size: int) -> CreditCards:
        return await self.repository.cards(self.owner(account), datetime.now(UTC), page, size)

    async def entries(
        self,
        account: Account,
        cursor: str | None,
        limit: int,
        kind: str | None,
        since: datetime | None,
        until: datetime | None,
    ) -> Entries:
        owner = self.owner(account)
        if since and until and since >= until:
            raise DomainError(422, "invalid billing time range")
        return await self.repository.entries(owner, cursor, limit, kind, since, until)

    async def detail(self, account: Account, entry_id: str) -> EntryDetail:
        return await self.repository.detail(self.owner(account), entry_id)

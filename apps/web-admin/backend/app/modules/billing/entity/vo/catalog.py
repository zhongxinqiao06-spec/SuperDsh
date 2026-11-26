"""平台套餐版本管理契约；金额统一为人民币分，生效时间必须携带时区。"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, model_validator
from pydantic.alias_generators import to_camel

from app.modules.billing.entity.vo.dto import BillingView, Plan


class CatalogCommand(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, str_strip_whitespace=True, extra="forbid"
    )
    business_key: UUID
    reason: str = Field(min_length=1, max_length=300)


class PublishPlan(CatalogCommand):
    expected_revision: Annotated[int, Field(strict=True, ge=0, lt=2147483647)]
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["membership", "addon"]
    term_unit: Literal["month", "year"]
    price_fen: Annotated[int, Field(strict=True, ge=0, le=2147483647)]
    points: Annotated[int, Field(strict=True, ge=1, le=2147483647)]
    listed: StrictBool
    effective_at: AwareDatetime | None = None

    def terms(self) -> dict[str, object]:
        """参与版本比较并冻结到办理单的商品条款。"""
        return self.model_dump(
            include={"name", "kind", "term_unit", "points", "price_fen", "listed"}
        )

    @model_validator(mode="after")
    def addon_price(self) -> "PublishPlan":
        if self.kind == "addon" and self.price_fen == 0:
            raise ValueError("加购包价格须大于零")
        return self


class PlanRelease(Plan):
    revision: int
    listed: bool
    effective_at: datetime
    published_at: datetime | None
    published_by: str | None
    publish_reason: str | None
    withdrawn_at: datetime | None
    withdrawn_by: str | None
    withdraw_reason: str | None


class PlanSeries(BillingView):
    """最新修订用于并发控制，当前版和待生效版按服务端时钟判断。"""

    latest: PlanRelease
    current: PlanRelease | None
    upcoming: PlanRelease | None


class PlanDirectory(BillingView):
    items: list[PlanSeries]
    total: int


class ReleaseHistory(BillingView):
    items: list[PlanRelease]
    total: int

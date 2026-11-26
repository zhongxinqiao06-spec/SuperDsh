"""定价与报价契约。数量取整由服务端统一执行，报价输入不接受客户端单价。"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from app.modules.billing.entity.vo.catalog import PublishPlan
from app.modules.billing.entity.vo.dto import BillingView


class PricingInput(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", str_strip_whitespace=True
    )


Token = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.*:/-]+$")]
Count = Annotated[int, Field(ge=1, le=1000000, strict=True)]
Revision = Annotated[int, Field(ge=0, le=2147483646, strict=True)]


class Selector(PricingInput):
    product: Literal["office", "entertainment"]
    capability: Token
    model: Token
    model_revision: Revision = 0
    spec: Token
    payer: Literal["platform", "personal"]

    def scope(self) -> str:
        return "|".join(
            (
                self.product,
                self.capability,
                self.model,
                str(self.model_revision),
                self.spec,
                self.payer,
            )
        )


class RateTerms(Selector):
    unit: Literal["second", "image", "character", "call"]
    unit_size: Count
    unit_points: Annotated[int, Field(ge=0, le=1000000, strict=True)]

    @model_validator(mode="after")
    def check_terms(self) -> "RateTerms":
        units = {
            "video.generate": "second",
            "speech.synthesize": "character",
            "image.generate": "image",
            "image.analyze": "image",
            "search": "call",
            "text.generate": "call",
        }
        if self.capability in units and self.unit != units[self.capability]:
            raise ValueError("计量单位与执行能力不一致")
        if self.payer == "personal" and self.unit_points != 0:
            raise ValueError("本人凭据承担的项目须为零点")
        if self.model == "*" and self.model_revision:
            raise ValueError("通用模型费率不能指定配置修订")
        return self


class RateDraft(PricingInput):
    terms: RateTerms
    expected_revision: Revision
    business_key: UUID
    reason: str = Field(min_length=1, max_length=300)


class PlanDraft(PricingInput):
    sku: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]
    expected_draft_revision: Revision
    terms: PublishPlan


class PublishDraft(PricingInput):
    revision: Annotated[int, Field(ge=1, le=2147483647, strict=True)]
    effective_at: AwareDatetime | None = None


class UsageItem(Selector):
    quantity: Count
    target: str | None = Field(default=None, min_length=1, max_length=160)


class Trial(PricingInput):
    item: UsageItem
    candidate: RateTerms | None = None


class QuoteRequest(PricingInput):
    business_key: UUID
    source: str = Field(min_length=1, max_length=100)
    items: Annotated[list[UsageItem], Field(min_length=1, max_length=100)]


class RateSnapshot(BillingView):
    """内置费率与运营草稿共用条款，只有运营草稿带保存请求号。"""

    terms: RateTerms
    reason: str
    business_key: UUID | None = None
    expected_revision: int | None = None


class VersionView[T](BillingView):
    id: str
    scope: str
    revision: int
    payload: T
    created_at: AwareDatetime
    effective_at: AwareDatetime | None
    published_by: str | None


class Versions[T](BillingView):
    items: list[VersionView[T]]
    total: int


class PricedItem(UsageItem):
    unit: Literal["second", "image", "character", "call"]
    unit_size: int
    unit_points: int
    units: int
    points: int


class TrialView(BillingView):
    current: PricedItem | None
    candidate: PricedItem | None
    difference: int | None


class QuotedItem(PricedItem):
    rate_id: str
    rate_revision: int


class QuoteView(BillingView):
    """时间沿用冻结快照的 ISO 字符串，查询和任务确认回执逐项一致。"""

    id: str
    source: str
    unlimited: bool = False
    items: list[QuotedItem]
    total_points: int
    expires_at: str
    locked_at: str | None

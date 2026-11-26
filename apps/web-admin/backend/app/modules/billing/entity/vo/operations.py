"""人工办理的冻结请求、确认回执与管理端最小账号摘要。"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from app.modules.billing.entity.vo.changes import ChangeSummary
from app.modules.billing.entity.vo.dto import BillingView

# 运营发卡面额由服务端校验，办理表单通过目录读取同一组数值。
CARD_DENOMINATIONS = (100, 200, 500, 1000, 2000)
Action = Literal["open", "renew", "gift", "compensation", "topup", "card"]
Payment = Literal["complimentary", "offline"]


class OperationInput(BillingView):
    """赠送／补偿自定点数，按商品办理时以服务端商品版本为准。"""

    model_config = ConfigDict(
        extra="forbid", str_strip_whitespace=True, alias_generator=to_camel, populate_by_name=True
    )
    user_id: str = Field(min_length=1, max_length=80)
    business_key: UUID
    action: Action
    reason: str = Field(min_length=1, max_length=300)
    plan_version_id: str | None = Field(None, min_length=1, max_length=80)
    points: Annotated[int, Field(strict=True, ge=1, le=1000000)] | None = None
    valid_days: Annotated[int, Field(strict=True, ge=1, le=3650)] | None = None
    payment: Payment = "complimentary"
    receipt: str | None = Field(None, min_length=1, max_length=120)
    received_fen: Annotated[int, Field(strict=True, ge=1, le=2147483647)] | None = None

    @model_validator(mode="after")
    def consistent(self) -> "OperationInput":
        if self.action == "card" and self.points not in CARD_DENOMINATIONS:
            raise ValueError("请选择有效的额度卡面额")
        manual = self.action in {"gift", "compensation", "card"}
        if manual and (
            self.points is None
            or self.valid_days is None
            or self.plan_version_id
            or self.payment != "complimentary"
        ):
            raise ValueError("赠送与补偿须填写点数和有效天数")
        if not manual and (
            not self.plan_version_id or self.points is not None or self.valid_days is not None
        ):
            raise ValueError("会员和加购额度须选定商品")
        if self.action == "topup" and self.payment != "offline":
            raise ValueError("加购必须登记实收")
        if self.payment == "offline" and (not self.receipt or self.received_fen is None):
            raise ValueError("须填写收款凭证及实收金额")
        if self.payment == "complimentary" and (
            self.receipt is not None or self.received_fen is not None
        ):
            raise ValueError("赠送不能关联收款")
        return self


class Quote(BillingView):
    plan_change_id: str | None = None
    username: str
    action: Action
    plan_name: str | None
    price_fen: int
    received_fen: int
    points: int
    immediate_points: int
    available_before: int
    available_after: int
    starts_at: datetime
    ends_at: datetime
    previous_end: datetime | None


class Operation(BillingView):
    id: str
    user_id: str
    quote: Quote
    expires_at: datetime
    confirmed_at: datetime | None


class ConfirmInput(BillingView):
    preview_id: UUID


class BillingAccount(BillingView):
    unlimited: bool
    revision: int
    last_booked_sku: str | None
    last_booked_name: str | None
    plan_change: ChangeSummary | None
    user_id: str
    username: str
    display_name: str | None
    disabled: bool
    plan_id: str | None
    plan_sku: str | None
    plan_name: str | None
    ends_at: datetime | None
    available_points: int
    state: Literal["active", "expired", "none"]


class BillingAccounts(BillingView):
    items: list[BillingAccount]
    total: int


class OperationRecord(Operation):
    receipt: str | None
    actor_id: str
    reason: str
    payment: Payment


class OperationHistory(BillingView):
    items: list[OperationRecord]
    has_more: bool

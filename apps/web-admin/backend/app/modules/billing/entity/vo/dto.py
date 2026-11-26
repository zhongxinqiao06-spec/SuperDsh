"""账户额度、版本化套餐及账务流水的只读传输契约。"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.modules.billing.entity.vo.changes import ChangeSummary


class BillingView(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class Plan(BillingView):
    """实际生效的价格以人民币分返回。"""

    id: str
    sku: str
    name: str
    kind: Literal["membership", "addon"]
    term_unit: Literal["month", "year"]
    price_fen: int
    points: int


class Catalog(BillingView):
    items: list[Plan]
    sale_open: bool
    sample_points_per_second: int
    sample_clip_points: int | None


class BookedPlan(BillingView):
    """当前档之后首个不同的已购档位，按原单展示。"""

    name: str
    starts_at: datetime


class Subscription(BillingView):
    next_booked_plan: BookedPlan | None = None
    plan: Plan
    starts_at: datetime
    ends_at: datetime
    next_grant_at: datetime | None


class Lot(BillingView):
    id: str
    source_key: str
    granted: int
    available_points: int
    held: int
    expires_at: datetime


class Wallet(BillingView):
    plan_change: ChangeSummary | None = None
    as_of: datetime
    available_points: int
    held_points: int
    expiring_points: int
    expiring_days: int
    subscription: Subscription | None
    lots: list[Lot]
    has_more_lots: bool


class Entry(BillingView):
    id: str
    kind: str
    available_delta: int
    held_delta: int
    created_at: datetime


class Entries(BillingView):
    items: list[Entry]
    next_cursor: str | None


class EntryDetail(Entry):
    lot_id: str
    source_key: str
    granted: int
    expires_at: datetime

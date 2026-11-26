"""换档请求与公开摘要。登记人、撤销原因仅供后台历史查询。"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ChangeModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, str_strip_whitespace=True, extra="forbid"
    )


class ChangeCommand(ChangeModel):
    expected_revision: Annotated[int, Field(strict=True, ge=1)]
    business_key: UUID
    reason: str = Field(min_length=1, max_length=300)


class ScheduleInput(ChangeCommand):
    plan_version_id: str = Field(min_length=1, max_length=80)


ChangeState = Literal["scheduled", "due", "booked", "effective", "cancelled"]


class ChangeSummary(ChangeModel):
    id: str
    from_plan_name: str
    from_plan_sku: str
    to_plan_name: str
    to_plan_sku: str
    to_version_id: str
    price_fen: int
    points: int
    effective_at: datetime
    state: ChangeState


class ChangeRecord(ChangeSummary):
    created_at: datetime
    actor_id: str
    reason: str
    booked_operation_id: str | None
    cancelled_at: datetime | None
    cancelled_by: str | None
    cancel_reason: str | None
    restores_change_id: str | None


class ChangeHistory(ChangeModel):
    items: list[ChangeRecord]
    has_more: bool

"""可编辑卡种的传输对象，发行请求只引用已保存的版本。"""

from pydantic import BaseModel, ConfigDict, Field, StrictBool
from pydantic.alias_generators import to_camel


class CardTypeInput(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="forbid",
        str_strip_whitespace=True,
    )
    name: str = Field(min_length=1, max_length=80)
    points: int = Field(strict=True, ge=1, le=1000000)
    valid_days: int = Field(strict=True, ge=1, le=3650)
    image: str = Field(min_length=1, max_length=2800000)
    enabled: StrictBool
    revision: int = Field(strict=True, ge=0, le=2147483646)


class CardType(CardTypeInput):
    id: str


class CardTypes(BaseModel):
    items: list[CardType]

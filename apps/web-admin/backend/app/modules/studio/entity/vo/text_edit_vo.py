"""选段和单场共用的 AI 编辑契约；偏移以 Unicode 字符计数。"""

from typing import Literal

from pydantic import ConfigDict, Field, model_validator

from app.modules.studio.entity.vo.foundation_vo import ProjectOperation
from app.modules.studio.entity.vo.studio_vo import Identifier, Input


class CreateTextEdit(ProjectOperation):
    scope: Literal["selection", "scene"]
    sceneId: Identifier | None = None
    start: int = Field(ge=0, le=100000)
    end: int = Field(ge=1, le=100000)
    instruction: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def bounds(self) -> "CreateTextEdit":
        if self.end <= self.start or self.end - self.start > 12000:
            raise ValueError("单次请选择 1 至 12000 字")
        if self.scope == "scene" and not self.sceneId:
            raise ValueError("请选择场次")
        return self


class SuggestText(Input):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    editId: Identifier
    replacement: str = Field(min_length=1, max_length=12000)


class ResolveTextEdit(ProjectOperation):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    action: Literal["apply", "undo", "discard"]
    replacement: str | None = Field(default=None, min_length=1, max_length=12000)

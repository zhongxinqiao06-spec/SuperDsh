"""快速视频一次生成一条；草稿、冻结预检、采用升级分别提交。"""

from typing import Literal, Self

from pydantic import Field, model_validator

from app.modules.studio.entity.vo.foundation_vo import ProjectOperation
from app.modules.studio.entity.vo.studio_vo import Identifier, Input, Notes


class QuickDraft(Input):
    prompt: Notes = ""
    inputMode: Literal["text", "image", "reference"] = "text"
    configurationId: Identifier | None = None
    durationSeconds: int = Field(default=5, ge=3, le=15)
    aspect: Literal["16:9", "9:16", "1:1", "4:3", "3:4"] = "16:9"
    resolution: Literal["720P"] = "720P"
    references: list[Identifier] = Field(default_factory=list, max_length=9)

    @model_validator(mode="after")
    def unique_references(self) -> Self:
        if len(self.references) != len(set(self.references)):
            raise ValueError("请勿重复选择同一参考素材版本")
        return self


class SaveQuick(ProjectOperation):
    title: str = Field(min_length=1, max_length=120)
    draft: QuickDraft


class QuickIntent(ProjectOperation):
    regenerate: bool = False
    allowDuplicate: bool = False
    reason: Notes = ""


class PromoteQuick(ProjectOperation):
    jobId: Identifier


class CollectQuick(PromoteQuick):
    name: str = Field(min_length=1, max_length=120)

"""基础制作契约：规格、幂等写入和角色版本操作不暴露数据库对象。"""

from typing import Literal, Self

from pydantic import Field, model_validator

from app.modules.studio.entity.vo.studio_vo import Identifier, Input, Notes


class ProjectBrief(Input):
    title: str = Field(min_length=1, max_length=120)
    brief: Notes = ""
    aspectWidth: int | None = Field(default=None, ge=1, le=100)
    aspectHeight: int | None = Field(default=None, ge=1, le=100)
    targetDurationMs: int | None = Field(default=None, ge=1000, le=3600000)
    language: str | None = Field(default=None, max_length=35)
    styleBrief: Notes = ""

    @model_validator(mode="after")
    def ratio(self) -> Self:
        if (self.aspectWidth is None) != (self.aspectHeight is None):
            raise ValueError("画幅宽高需要一起填写")
        return self


class CreateProject(ProjectBrief):
    requestKey: Identifier | None = None
    creationMode: Literal["storyboard", "quick"] = "storyboard"


class UpdateBrief(ProjectBrief):
    revision: int = Field(ge=1)
    requestKey: Identifier


class ProjectOperation(Input):
    revision: int = Field(ge=1)
    requestKey: Identifier


class ArchiveProject(ProjectOperation):
    archived: bool

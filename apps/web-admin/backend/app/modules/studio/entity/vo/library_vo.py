"""素材库收藏、明确版本引用和三方更新的请求契约。"""

from typing import Literal, Self

from pydantic import Field, model_validator

from app.modules.studio.entity.vo.studio_vo import Identifier, Input

LibraryField = Literal["name", "description", "appearance", "voice"]


class CollectLibrary(Input):
    sourceVersionId: Identifier
    requestKey: Identifier
    mode: Literal["new", "update", "variant"] = "new"
    expectedVersionId: Identifier | None = None
    variantName: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode="after")
    def variant(self) -> Self:
        if self.mode == "variant" and not self.variantName:
            raise ValueError("请为新造型或环境变体命名")
        return self


class ImportLibrary(Input):
    sourceVersionId: Identifier
    requestKey: Identifier
    expectedRevision: int = Field(ge=1)


class ArchiveLibrary(Input):
    requestKey: Identifier
    expectedVersionId: Identifier
    archived: bool


class PreviewLibraryUpdate(Input):
    assetId: Identifier


class ApplyLibraryUpdate(PreviewLibraryUpdate):
    sourceVersionId: Identifier
    expectedRevision: int = Field(ge=1)
    requestKey: Identifier
    fields: list[LibraryField] = Field(min_length=1, max_length=4)
    overwriteConflicts: bool = False

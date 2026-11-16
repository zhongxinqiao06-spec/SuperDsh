"""导演起草前的参考资料契约；文件和素材只接受已授权资源 ID。"""

from pydantic import Field

from app.modules.studio.entity.vo.foundation_vo import ProjectOperation
from app.modules.studio.entity.vo.studio_vo import Identifier, Input


class ContextUpload(Input):
    fileId: Identifier
    name: str = Field(min_length=1, max_length=120)


class PrepareDirectorContext(ProjectOperation):
    assetIds: list[Identifier] = Field(default_factory=list, max_length=4)
    uploads: list[ContextUpload] = Field(default_factory=list, max_length=4)
    analyzeImages: bool = False
    researchQuery: str = Field(default="", max_length=1000, pattern=r"^[^\x00]*$")

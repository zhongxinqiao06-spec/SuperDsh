"""准备阶段确认、字段级草案与试做契约；所有写入绑定当前工程和操作号。"""

from typing import Literal

from pydantic import Field

from app.modules.studio.entity.vo.foundation_vo import ProjectOperation
from app.modules.studio.entity.vo.studio_vo import Document, Identifier, Notes, Short

Stage = Literal["script", "cast", "storyboard", "sample"]


class ConfirmStage(ProjectOperation):
    """用户明确审阅的阶段及可选略过项，不以页面访问隐式确认。"""

    decision: Literal["confirmed", "skipped"] = "confirmed"
    reason: Notes = ""
    acknowledged: bool = False
    waived: list[Short] = Field(default_factory=list, max_length=1000)
    shots: list[Identifier] = Field(default_factory=list, max_length=200)


class ProposeDocument(ProjectOperation):
    """导演建议的完整文档，修订与操作号来自已读取的作品。"""

    document: Document


class ReviewFields(ProjectOperation):
    """选择字段与显式覆盖冲突字段分开，未选择内容保持当前值。"""

    selected: list[Short] = Field(default_factory=list, max_length=5000)
    overrides: list[Short] = Field(default_factory=list, max_length=5000)


class PreparationJob(ProjectOperation):
    """角色参考、分镜图或声音试听的制作意图，提交须携带预检摘要。"""

    kind: Literal["reference", "storyboard", "voice"]
    target: Identifier
    configuration: Identifier | None = None
    prompt: Notes = ""
    voice: Short = ""
    text: str = Field(default="", max_length=500)
    useReference: bool = True
    planHash: str | None = Field(default=None, pattern="^[a-f0-9]{64}$")


class AdoptPreparation(ProjectOperation):
    """成功候选及本片采用目标；目标必须与生成来源关联。"""

    job: Identifier
    target: Identifier

"""制作范围、付费确认和任务处置分别建模，重复操作保留原请求号。"""

from typing import Literal

from pydantic import Field

from app.modules.studio.entity.vo.foundation_vo import ProjectOperation
from app.modules.studio.entity.vo.studio_vo import Identifier, Notes, Short


class ProductionIntent(ProjectOperation):
    mode: Literal["missing", "failed", "selected", "all"] = "missing"
    shots: list[Identifier] = Field(default_factory=list, max_length=200)
    lines: list[Identifier] = Field(default_factory=list, max_length=2000)
    video: Identifier | None = None
    referenceVideo: Identifier | None = None
    speech: Identifier | None = None
    allowDuplicate: bool = False
    reason: Notes = ""


class ConfirmPlan(ProjectOperation):
    planHash: str = Field(pattern="^[a-f0-9]{64}$")


class JobDecision(ProjectOperation):
    action: Literal["cancel", "resume", "receipt", "unaccepted", "keep"]
    reason: Notes = ""
    providerTask: Short = ""
    acknowledged: bool = False


class PersonalIntent(ProjectOperation):
    kind: Literal["reference", "voice"]
    configuration: Identifier | None = None
    prompt: Notes = ""
    text: str = Field(default="", max_length=500)
    voice: Short = ""
    useReference: bool = True
    allowDuplicate: bool = False
    reason: Notes = ""


class PersonalAdopt(ProjectOperation):
    job: Identifier

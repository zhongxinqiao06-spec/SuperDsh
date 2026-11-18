"""创作工程兼容契约使用整数毫秒；存储层统一转换为精确时间刻度。"""

from typing import Annotated, Literal, Self
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")]
Short = Annotated[str, Field(max_length=240)]
Notes = Annotated[str, Field(max_length=12000)]
Millis = Annotated[int, Field(ge=0, le=3600000)]
Volume = Annotated[float, Field(ge=0, le=2)]


def identifier() -> str:
    return uuid4().hex


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Line(Input):
    id: Identifier = Field(default_factory=identifier)
    role: Identifier
    text: Notes
    voice: Short = ""
    subtitle: Notes | None = None
    subtitleStart: Millis | None = None
    start: Millis = 0
    end: Millis | None = None
    audio: Identifier | None = None
    audioAssetId: Identifier | None = None
    volume: Volume = 1

    @model_validator(mode="after")
    def audio_source(self) -> Self:
        if self.audio and self.audioAssetId:
            raise ValueError("配音只能选择生成候选或媒体素材其中之一")
        return self


class Shot(Input):
    id: Identifier = Field(default_factory=identifier)
    action: Notes
    scene: Short = ""
    sceneId: Identifier | None = None
    sceneAssetId: Identifier | None = None
    camera: Short = ""
    framing: Short = ""
    movement: Short = ""
    duration: int = Field(default=5000, ge=1000, le=120000)
    references: list[Identifier] = Field(default_factory=list, max_length=64)
    lines: list[Line] = Field(default_factory=list, max_length=64)
    candidate: Identifier | None = None
    videoAssetId: Identifier | None = None
    trimStart: Millis = 0
    trimEnd: Millis | None = None

    @model_validator(mode="after")
    def trim(self) -> Self:
        if self.candidate and self.videoAssetId:
            raise ValueError("画面只能选择生成候选或媒体素材其中之一")
        if (
            not self.trimStart
            < (self.trimEnd if self.trimEnd is not None else self.duration)
            <= self.duration
        ):
            raise ValueError("裁剪范围超出镜头")
        for line in self.lines:
            caption_start = line.start if line.subtitleStart is None else line.subtitleStart
            if line.end is not None and line.end <= caption_start:
                raise ValueError("字幕结束必须晚于开始")
        return self


class ScriptRange(Input):
    """场次关联当前正文的 Unicode 范围，编辑请求另存基线防止偏移误写。"""

    start: int = Field(ge=0, le=100000)
    end: int = Field(ge=1, le=100000)


class StorySceneInput(Input):
    """场次有独立身份，空场次也能先规划，再分配镜头。"""

    id: Identifier = Field(default_factory=identifier)
    title: Short
    synopsis: Notes = ""
    scriptRange: ScriptRange | None = None
    sceneAssetId: Identifier | None = None


class SoundEffect(Input):
    """音效可锚定镜头以随镜重排；空锚点表示全片绝对时间。"""

    id: Identifier = Field(default_factory=identifier)
    assetId: Identifier
    shotId: Identifier | None = None
    start: Millis = 0
    volume: Volume = 1
    trimStart: Millis = 0
    trimEnd: Millis | None = None

    @model_validator(mode="after")
    def trim(self) -> Self:
        if self.trimEnd is not None and self.trimEnd <= self.trimStart:
            raise ValueError("音效裁剪结束必须晚于开始")
        return self


class Document(Input):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    script: str = Field(default="", max_length=100000)
    adaptationMode: Literal["original", "adapt"] = "original"
    scenes: list[StorySceneInput] = Field(default_factory=list, max_length=200)
    assets: list[Identifier] = Field(default_factory=list, max_length=1000)
    shots: list[Shot] = Field(default_factory=list, max_length=200)
    music: Identifier | None = None
    musicVolume: Volume = 0.25
    soundEffects: list[SoundEffect] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def identifiers(self) -> Self:
        ids = [s.id for s in self.shots] + [line.id for s in self.shots for line in s.lines]
        if len(ids) != len(set(ids)) or len(self.assets) != len(set(self.assets)):
            raise ValueError("素材、镜头或台词标识重复")
        scene_ids = [scene.id for scene in self.scenes]
        if len(scene_ids) != len(set(scene_ids)):
            raise ValueError("场次标识重复")
        effect_ids = [effect.id for effect in self.soundEffects]
        if len(effect_ids) != len(set(effect_ids)):
            raise ValueError("音效标识重复")
        shot_ids = {shot.id for shot in self.shots}
        if any(effect.shotId and effect.shotId not in shot_ids for effect in self.soundEffects):
            raise ValueError("音效绑定的镜头不存在")
        for scene in self.scenes:
            if (
                scene.scriptRange
                and not 0 <= scene.scriptRange.start < scene.scriptRange.end <= len(self.script)
            ):
                raise ValueError("场次关联范围超出正文")
        return self


class NewProject(Input):
    title: str = Field(min_length=1, max_length=120)


class SaveDocument(Input):
    revision: int = Field(ge=1)
    document: Document
    label: Short = "编辑工程"
    requestKey: Identifier | None = None


class AssetInput(Input):
    kind: Literal["character", "scene", "prop", "image", "video", "audio", "music"]
    name: str = Field(min_length=1, max_length=120)
    description: Notes = ""
    voice: Short = ""
    fileId: Identifier | None = None
    parent: Identifier | None = None
    project: Identifier | None = None
    requestKey: Identifier | None = None
    expectedVersionId: Identifier | None = None


class Review(Input):
    revision: int = Field(ge=1)
    proposalId: Identifier
    selected: list[Identifier] = Field(max_length=400)


class Batch(Input):
    revision: int = Field(ge=1)
    requestKey: Identifier
    shots: list[Identifier] = Field(default_factory=list, max_length=200)
    lines: list[Identifier] = Field(default_factory=list, max_length=500)
    video: Identifier | None = None
    referenceVideo: Identifier | None = None
    speech: Identifier | None = None
    export: bool = False

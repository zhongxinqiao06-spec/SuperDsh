"""整剧、分集与编排建议的公开契约；所有写入使用整剧修订和幂等请求号。"""

from typing import Literal, Self

from pydantic import Field, model_validator

from app.modules.studio.entity.vo.foundation_vo import ProjectBrief, ProjectOperation
from app.modules.studio.entity.vo.studio_vo import Identifier, Input, Notes

StoryField = Literal["synopsis", "opening", "development", "ending", "continuity"]


class SeriesBrief(ProjectBrief):
    narrativeMode: Literal["continuous", "anthology"] = "continuous"
    plannedEpisodes: int = Field(default=6, ge=1, le=100)


class CreateSeries(SeriesBrief):
    """创建整剧只建立规划，不自动生成剧本或收费媒体。"""

    requestKey: Identifier
    createEpisodeDrafts: bool = False


class UpdateSeries(SeriesBrief, ProjectOperation):
    pass


class EpisodeStory(Input):
    """按可阅读故事组织四段，前后集承接独立于当前制作工程。"""

    synopsis: Notes = ""
    opening: Notes = ""
    development: Notes = ""
    ending: Notes = ""
    continuity: Notes = ""


class EpisodeInput(Input):
    title: str = Field(min_length=1, max_length=120)
    story: EpisodeStory = Field(default_factory=EpisodeStory)
    targetDurationMs: int = Field(default=45000, ge=1000, le=3600000)


class CreateEpisode(EpisodeInput, ProjectOperation):
    pass


class UpdateEpisode(EpisodeInput, ProjectOperation):
    pass


class ConfirmEpisode(ProjectOperation):
    projectRevision: int = Field(ge=1)


class LockEpisode(ProjectOperation):
    locked: bool


class ReorderEpisodes(ProjectOperation):
    episodeIds: list[Identifier] = Field(min_length=1, max_length=100)


class SeriesSettings(ProjectOperation):
    assetVersionIds: list[Identifier] = Field(default_factory=list, max_length=100)


class ApplySeriesSettings(ProjectOperation):
    episodeIds: list[Identifier] = Field(min_length=1, max_length=100)
    projectRevisions: dict[Identifier, int]


class CreateSeriesProposal(ProjectOperation):
    episodeIds: list[Identifier] = Field(min_length=1, max_length=20)
    instruction: str = Field(min_length=1, max_length=2000)


class EpisodeSuggestion(Input):
    episodeId: Identifier
    story: EpisodeStory


class SuggestSeriesProposal(Input):
    proposalId: Identifier
    episodes: list[EpisodeSuggestion] = Field(min_length=1, max_length=20)


class EpisodeFieldSelection(Input):
    episodeId: Identifier
    fields: list[StoryField] = Field(min_length=1, max_length=5)


class ResolveSeriesProposal(ProjectOperation):
    action: Literal["apply", "discard"]
    selected: list[EpisodeFieldSelection] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def selection(self) -> Self:
        if self.action == "apply" and not self.selected:
            raise ValueError("请至少选择一处故事修改")
        if len({row.episodeId for row in self.selected}) != len(self.selected):
            raise ValueError("请勿重复选择同一集")
        return self


class RemoveEpisode(ProjectOperation):
    projectRevision: int = Field(ge=1)


class ImportEpisode(ProjectOperation):
    projectId: Identifier
    projectRevision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=120)


class StructurePlanInput(ProjectOperation):
    """拆合仅处理故事规划；新集不隐式搬迁旧镜头、媒体和剪辑。"""

    action: Literal["split", "merge"]
    episodeIds: list[Identifier] = Field(min_length=1, max_length=20)
    episodes: list[EpisodeInput] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def scope(self) -> Self:
        if len(set(self.episodeIds)) != len(self.episodeIds):
            raise ValueError("分集不能重复")
        if self.action == "split" and (len(self.episodeIds) != 1 or len(self.episodes) < 2):
            raise ValueError("拆集需要选择一集，并准备至少两集的新故事")
        if self.action == "merge" and (len(self.episodeIds) < 2 or len(self.episodes) != 1):
            raise ValueError("合并需要选择至少两集，并准备一集的新故事")
        return self


class ConfirmStructurePlan(ProjectOperation):
    planHash: str = Field(pattern="^[a-f0-9]{64}$")

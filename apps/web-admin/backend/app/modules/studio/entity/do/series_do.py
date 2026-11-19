"""系列短剧持久对象；分集身份独立于集序，单集继续使用既有作品工程。"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class StudioSeries(Base):
    __tablename__ = "studio_series"
    id: Mapped[str] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str]
    revision: Mapped[int] = mapped_column(default=1)
    brief: Mapped[str] = mapped_column(default="")
    narrative_mode: Mapped[str] = mapped_column(default="continuous")
    planned_episodes: Mapped[int] = mapped_column(default=6)
    lifecycle: Mapped[str] = mapped_column(default="active")
    aspect_width: Mapped[int | None]
    aspect_height: Mapped[int | None]
    target_duration_ms: Mapped[int | None]
    language: Mapped[str | None]
    style_brief: Mapped[str] = mapped_column(default="")
    settings_revision: Mapped[int] = mapped_column(default=1)
    creation_key: Mapped[str]
    creation_hash: Mapped[str]
    updated: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("id", "owner"),
        UniqueConstraint("owner", "creation_key"),
        CheckConstraint("narrative_mode IN ('continuous','anthology')"),
        CheckConstraint("lifecycle IN ('active','archived')"),
        CheckConstraint("planned_episodes BETWEEN 1 AND 100"),
        CheckConstraint("revision > 0 AND settings_revision > 0"),
    )


class SeriesSettingVersion(Base):
    """全剧设定保存明确的素材版本 ID，新版本不会自动改写已制作的集。"""

    __tablename__ = "studio_series_setting_versions"
    series_id: Mapped[str] = mapped_column(ForeignKey("studio_series.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(primary_key=True)
    asset_version_ids: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioEpisode(Base):
    __tablename__ = "studio_series_episodes"
    id: Mapped[str] = mapped_column(primary_key=True)
    series_id: Mapped[str]
    owner: Mapped[str]
    project_id: Mapped[str] = mapped_column(unique=True)
    position: Mapped[int]
    title: Mapped[str]
    story: Mapped[dict] = mapped_column(JSONB)
    story_revision: Mapped[int] = mapped_column(default=1)
    confirmed_story_revision: Mapped[int | None]
    confirmed_project_revision: Mapped[int | None]
    confirmed_script_hash: Mapped[str | None]
    settings_revision: Mapped[int]
    target_duration_ms: Mapped[int]
    locked: Mapped[bool] = mapped_column(default=False)
    unlocked_export_id: Mapped[str | None] = mapped_column(ForeignKey("studio_media_jobs.id"))
    archived: Mapped[bool] = mapped_column(default=False, server_default="false")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archive_reason: Mapped[str | None]
    __table_args__ = (
        ForeignKeyConstraint(["series_id", "owner"], ["studio_series.id", "studio_series.owner"]),
        ForeignKeyConstraint(
            ["project_id", "owner"], ["studio_projects.id", "studio_projects.owner"]
        ),
        ForeignKeyConstraint(
            ["series_id", "settings_revision"],
            ["studio_series_setting_versions.series_id", "studio_series_setting_versions.revision"],
        ),
        UniqueConstraint("series_id", "position", deferrable=True, initially="DEFERRED"),
        CheckConstraint("position > 0 AND story_revision > 0 AND target_duration_ms > 0"),
    )


class SeriesCommand(Base):
    """同一整剧内的幂等写入回执与领域事务同时提交。"""

    __tablename__ = "studio_series_commands"
    id: Mapped[str] = mapped_column(primary_key=True)
    series_id: Mapped[str] = mapped_column(ForeignKey("studio_series.id"), index=True)
    operation_key: Mapped[str]
    request_hash: Mapped[str]
    result: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("series_id", "operation_key"),)


class SeriesProposal(Base):
    """导演只能写入冻结范围内的建议，人工采用才更新分集故事。"""

    __tablename__ = "studio_series_proposals"
    id: Mapped[str] = mapped_column(primary_key=True)
    series_id: Mapped[str] = mapped_column(ForeignKey("studio_series.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"))
    base_revision: Mapped[int]
    original: Mapped[list] = mapped_column(JSONB)
    suggestions: Mapped[list] = mapped_column(JSONB, default=list)
    instruction: Mapped[str]
    prompt_text: Mapped[str] = mapped_column(default="")
    state: Mapped[str] = mapped_column(default="waiting")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("state IN ('waiting','ready','applied','discarded')"),)


class SeriesStructurePlan(Base):
    """结构变更预览冻结源工程修订和新故事，确认前不移动或归档任何集。"""

    __tablename__ = "studio_series_structure_plans"
    id: Mapped[str] = mapped_column(primary_key=True)
    series_id: Mapped[str] = mapped_column(ForeignKey("studio_series.id"), index=True)
    revision: Mapped[int]
    manifest: Mapped[dict] = mapped_column(JSONB)
    plan_hash: Mapped[str]
    state: Mapped[str] = mapped_column(default="prepared")
    result: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("state IN ('prepared','confirmed')"),)

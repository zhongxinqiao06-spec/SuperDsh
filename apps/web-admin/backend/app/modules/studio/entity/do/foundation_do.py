"""作品基础对象；当前草稿按实体保存，历史文档只作为不可变兼容快照。"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class StudioScript(Base):
    """一作品一份原稿；场次和台词的稳定身份独立于原文字符偏移。"""

    __tablename__ = "studio_scripts"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    source_text: Mapped[str] = mapped_column(default="")
    adaptation_mode: Mapped[str] = mapped_column(String(20), default="original")
    revision: Mapped[int] = mapped_column(BigInteger, default=1)
    __table_args__ = (CheckConstraint("adaptation_mode IN ('original','adapt')"),)


class StoryScene(Base):
    """旧工程允许不同作品使用相同镜头/场次 ID，主键显式包含作品。"""

    __tablename__ = "studio_story_scenes"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(primary_key=True)
    title: Mapped[str]
    synopsis: Mapped[str] = mapped_column(default="")
    script_range: Mapped[dict | None] = mapped_column(JSONB)
    position: Mapped[int] = mapped_column(BigInteger)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StudioShot(Base):
    __tablename__ = "studio_shots"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(primary_key=True)
    story_scene_id: Mapped[str]
    position: Mapped[int] = mapped_column(BigInteger)
    action: Mapped[str]
    scene: Mapped[str] = mapped_column(default="")
    camera: Mapped[str] = mapped_column(default="")
    framing: Mapped[str] = mapped_column(default="")
    movement: Mapped[str] = mapped_column(default="")
    planned_duration_ms: Mapped[int] = mapped_column(BigInteger)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "story_scene_id"],
            ["studio_story_scenes.project_id", "studio_story_scenes.id"],
        ),
        CheckConstraint("planned_duration_ms > 0"),
    )


class StudioLine(Base):
    __tablename__ = "studio_lines"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    id: Mapped[str] = mapped_column(primary_key=True)
    shot_id: Mapped[str]
    position: Mapped[int] = mapped_column(BigInteger)
    speaker_version_id: Mapped[str] = mapped_column(ForeignKey("studio_entity_versions.id"))
    text: Mapped[str]
    voice: Mapped[str] = mapped_column(default="")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "shot_id"], ["studio_shots.project_id", "studio_shots.id"]
        ),
    )


class ProjectAsset(Base):
    __tablename__ = "studio_project_assets"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    asset_version_id: Mapped[str] = mapped_column(
        ForeignKey("studio_asset_versions.id"), primary_key=True
    )
    position: Mapped[int]


class ProjectEntityVersion(Base):
    """作品可同时保留同一角色的多个造型版本，目录引用不等于当前默认造型。"""

    __tablename__ = "studio_project_entity_versions"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    entity_version_id: Mapped[str] = mapped_column(
        ForeignKey("studio_entity_versions.id"), primary_key=True
    )
    position: Mapped[int]


class ShotReference(Base):
    __tablename__ = "studio_shot_references"
    project_id: Mapped[str] = mapped_column(primary_key=True)
    shot_id: Mapped[str] = mapped_column(primary_key=True)
    position: Mapped[int] = mapped_column(primary_key=True)
    entity_version_id: Mapped[str | None] = mapped_column(ForeignKey("studio_entity_versions.id"))
    asset_version_id: Mapped[str | None] = mapped_column(ForeignKey("studio_asset_versions.id"))
    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "shot_id"], ["studio_shots.project_id", "studio_shots.id"]
        ),
        CheckConstraint("num_nonnulls(entity_version_id, asset_version_id) = 1"),
    )


class StudioCommand(Base):
    """与领域写入同事务提交的幂等回执；断网重试不重复增修订。"""

    __tablename__ = "studio_commands"
    id: Mapped[str] = mapped_column(primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"))
    operation_key: Mapped[str] = mapped_column(String(160))
    request_hash: Mapped[str] = mapped_column(String(64))
    command_type: Mapped[str] = mapped_column(String(50))
    result: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("owner_id", "project_id", "operation_key"),)


class ProjectSnapshot(Base):
    """阶段检查点包含规格和当前工程，兼容旧的仅文档历史记录。"""

    __tablename__ = "studio_project_snapshots"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    project_revision: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    manifest: Mapped[dict] = mapped_column(JSONB)
    manifest_hash: Mapped[str] = mapped_column(String(64))
    label: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

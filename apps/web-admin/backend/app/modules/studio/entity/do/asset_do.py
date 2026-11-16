"""人物设定与媒体文件分别版本化；个人库引用进入作品时建立独立身份。"""

from datetime import datetime

from sqlalchemy import (
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


class StudioEntity(Base):
    __tablename__ = "studio_entities"
    id: Mapped[str] = mapped_column(primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("studio_projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str]
    current_version_id: Mapped[str]
    position: Mapped[int] = mapped_column(default=0)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    __table_args__ = (
        CheckConstraint("kind IN ('character','scene','prop')"),
        ForeignKeyConstraint(
            ["id", "current_version_id"],
            ["studio_entity_versions.entity_id", "studio_entity_versions.id"],
            name="fk_studio_entity_current",
            deferrable=True,
            initially="DEFERRED",
            use_alter=True,
        ),
    )


class EntityVersion(Base):
    __tablename__ = "studio_entity_versions"
    id: Mapped[str] = mapped_column(primary_key=True)
    entity_id: Mapped[str] = mapped_column(ForeignKey("studio_entities.id"), index=True)
    version_no: Mapped[int]
    origin_version_id: Mapped[str | None] = mapped_column(ForeignKey("studio_entity_versions.id"))
    name: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    voice_id: Mapped[str] = mapped_column(default="")
    voice_configuration_id: Mapped[str | None] = mapped_column(String(100))
    voice_configuration_revision: Mapped[int | None]
    voice_parameters: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("entity_id", "version_no"),
        UniqueConstraint("entity_id", "id"),
        ForeignKeyConstraint(
            ["voice_configuration_id", "voice_configuration_revision"],
            [
                "model_configuration_versions.configuration_id",
                "model_configuration_versions.revision",
            ],
        ),
        CheckConstraint("version_no > 0"),
        CheckConstraint(
            "num_nonnulls(voice_configuration_id, voice_configuration_revision) IN (0,2)"
        ),
    )


class AssetFamily(Base):
    __tablename__ = "studio_asset_families"
    id: Mapped[str] = mapped_column(primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("studio_projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str]
    current_version_id: Mapped[str]
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        ForeignKeyConstraint(
            ["id", "current_version_id"],
            ["studio_asset_versions.family_id", "studio_asset_versions.id"],
            name="fk_studio_asset_current",
            deferrable=True,
            initially="DEFERRED",
            use_alter=True,
        ),
    )


class AssetVersion(Base):
    __tablename__ = "studio_asset_versions"
    id: Mapped[str] = mapped_column(primary_key=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("studio_asset_families.id"), index=True)
    version_no: Mapped[int]
    parent_version_id: Mapped[str | None] = mapped_column(ForeignKey("studio_asset_versions.id"))
    file_id: Mapped[str | None] = mapped_column(ForeignKey("web_file_entries.id"))
    name: Mapped[str]
    description: Mapped[str] = mapped_column(default="")
    source_job_id: Mapped[str | None] = mapped_column(ForeignKey("studio_media_jobs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("family_id", "version_no"),
        UniqueConstraint("family_id", "id"),
        CheckConstraint("version_no > 0"),
    )


class EntityVersionAsset(Base):
    __tablename__ = "studio_entity_version_assets"
    entity_version_id: Mapped[str] = mapped_column(
        ForeignKey("studio_entity_versions.id"), primary_key=True
    )
    asset_version_id: Mapped[str] = mapped_column(
        ForeignKey("studio_asset_versions.id"), primary_key=True
    )
    purpose: Mapped[str] = mapped_column(String(40), primary_key=True)
    position: Mapped[int]
    __table_args__ = (UniqueConstraint("entity_version_id", "purpose", "position"),)

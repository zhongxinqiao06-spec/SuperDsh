"""基础时间线：采用来源、裁剪和字幕位置只有一处当前状态。"""

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class StudioTimeline(Base):
    __tablename__ = "studio_timelines"
    project_id: Mapped[str] = mapped_column(ForeignKey("studio_projects.id"), primary_key=True)
    ticks_per_second: Mapped[int] = mapped_column(BigInteger)
    fps_num: Mapped[int]
    fps_den: Mapped[int]
    audio_sample_rate: Mapped[int]
    music_gain: Mapped[float] = mapped_column(default=0.25, server_default="0.25")
    __table_args__ = (
        CheckConstraint(
            "ticks_per_second > 0 AND fps_num > 0 AND fps_den > 0 AND audio_sample_rate > 0"
        ),
    )


class StudioTrack(Base):
    __tablename__ = "studio_tracks"
    project_id: Mapped[str] = mapped_column(
        ForeignKey("studio_timelines.project_id"), primary_key=True
    )
    id: Mapped[str] = mapped_column(primary_key=True)
    kind: Mapped[str]
    position: Mapped[int]
    __table_args__ = (
        UniqueConstraint("project_id", "position", deferrable=True, initially="DEFERRED"),
    )


class StudioClip(Base):
    __tablename__ = "studio_clips"
    project_id: Mapped[str] = mapped_column(primary_key=True)
    id: Mapped[str] = mapped_column(primary_key=True)
    track_id: Mapped[str]
    shot_id: Mapped[str | None]
    line_id: Mapped[str | None]
    role: Mapped[str]
    job_id: Mapped[str | None] = mapped_column(ForeignKey("studio_media_jobs.id"))
    asset_version_id: Mapped[str | None] = mapped_column(ForeignKey("studio_asset_versions.id"))
    start_ticks: Mapped[int] = mapped_column(BigInteger)
    duration_ticks: Mapped[int] = mapped_column(BigInteger)
    source_start_ticks: Mapped[int] = mapped_column(BigInteger, default=0)
    source_duration_ticks: Mapped[int | None] = mapped_column(BigInteger)
    subtitle_text: Mapped[str | None]
    gain: Mapped[float] = mapped_column(default=1)
    timing_mode: Mapped[str] = mapped_column(default="manual")
    anchor_offset_ticks: Mapped[int] = mapped_column(BigInteger, default=0)
    subtitle_follow_voice: Mapped[bool] = mapped_column(default=True)
    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "track_id"], ["studio_tracks.project_id", "studio_tracks.id"]
        ),
        ForeignKeyConstraint(
            ["project_id", "shot_id"], ["studio_shots.project_id", "studio_shots.id"]
        ),
        ForeignKeyConstraint(
            ["project_id", "line_id"], ["studio_lines.project_id", "studio_lines.id"]
        ),
        ForeignKeyConstraint(
            ["project_id", "job_id"], ["studio_media_jobs.project", "studio_media_jobs.id"]
        ),
        CheckConstraint("start_ticks >= 0 AND duration_ticks >= 0 AND source_start_ticks >= 0"),
        CheckConstraint("num_nonnulls(job_id, asset_version_id) <= 1"),
    )

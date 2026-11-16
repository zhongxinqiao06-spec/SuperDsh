"""个人库制作与工程共用媒体队列，追加冻结制作计划与任务处置审计。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "fc830ef406bc"
down_revision = "fb720de395af"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("studio_media_jobs", "project", nullable=True)
    op.add_column("studio_media_jobs", sa.Column("owner", sa.String(), sa.ForeignKey("users.id")))
    op.add_column(
        "studio_media_jobs",
        sa.Column("library_entity", sa.String(), sa.ForeignKey("studio_entities.id")),
    )
    op.add_column(
        "studio_media_jobs",
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        "UPDATE studio_media_jobs j SET owner=p.owner FROM studio_projects p WHERE j.project=p.id"
    )
    op.create_index("ix_studio_media_jobs_owner", "studio_media_jobs", ["owner"])
    op.create_index(
        "uq_studio_personal_request",
        "studio_media_jobs",
        ["owner", "request_key", "subject"],
        unique=True,
        postgresql_where=sa.text("project IS NULL"),
    )
    op.create_check_constraint(
        "ck_studio_job_scope",
        "studio_media_jobs",
        "project IS NOT NULL OR (owner IS NOT NULL AND library_entity IS NOT NULL)",
    )
    op.create_table(
        "studio_generation_plans",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("project", sa.String(), sa.ForeignKey("studio_projects.id")),
        sa.Column("entity", sa.String(), sa.ForeignKey("studio_entities.id")),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("request_key", sa.String(), nullable=False),
        sa.Column("request_hash", sa.String(), nullable=False),
        sa.Column("plan_hash", sa.String(), nullable=False),
        sa.Column("intent", JSONB(), nullable=False),
        sa.Column("manifest", JSONB(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("result", JSONB()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("owner", "request_key"),
        sa.CheckConstraint("num_nonnulls(project, entity) = 1"),
    )
    op.create_index("ix_studio_generation_plans_owner", "studio_generation_plans", ["owner"])
    op.create_table(
        "studio_job_actions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("job", sa.String(), sa.ForeignKey("studio_media_jobs.id"), nullable=False),
        sa.Column("request_key", sa.String(), nullable=False),
        sa.Column("request_hash", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("detail", JSONB(), nullable=False),
        sa.Column("result", JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("owner", "request_key"),
    )
    op.create_index("ix_studio_job_actions_job", "studio_job_actions", ["job"])


def downgrade() -> None:
    raise RuntimeError("制作计划与处置记录不可丢弃，请使用升级前备份恢复")

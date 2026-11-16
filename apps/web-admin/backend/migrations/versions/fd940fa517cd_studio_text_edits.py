"""场次正文关联与可撤回的局部 AI 修改。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "fd940fa517cd"
down_revision = "fc830ef406bc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("studio_story_scenes", sa.Column("script_range", JSONB()))
    op.create_table(
        "studio_text_edits",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("studio_projects.id"), nullable=False),
        sa.Column("request_key", sa.String(), nullable=False),
        sa.Column("request_hash", sa.String(), nullable=False),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("target", JSONB(), nullable=False),
        sa.Column("base_text", sa.String(), nullable=False),
        sa.Column("instruction", sa.String(), nullable=False),
        sa.Column("suggestion", sa.String()),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("applied", JSONB()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "request_key"),
        sa.CheckConstraint("state IN ('waiting','ready','applied','discarded','undone')"),
    )
    op.create_index("ix_studio_text_edits_project_id", "studio_text_edits", ["project_id"])


def downgrade() -> None:
    op.drop_table("studio_text_edits")
    op.drop_column("studio_story_scenes", "script_range")

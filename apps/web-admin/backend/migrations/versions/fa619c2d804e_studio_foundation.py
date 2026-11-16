"""作品基础结构化存储，素材旧表保留为只读来源。"""

import json
from pathlib import Path

import sqlalchemy as sa
from alembic import op

from migrations.data.studio_foundation_data import ASSET_VIEW, migrate_assets, migrate_projects
from migrations.data.studio_foundation_navigation import upgrade_navigation

revision = "fa619c2d804e"
down_revision = "f28d6419b037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    # 与现有媒体执行器使用同一锁，禁止迁移时仍有旧执行器修改工程。
    if not connection.scalar(
        sa.text("SELECT pg_try_advisory_xact_lock(hashtext('studio-media-worker'))")
    ):
        raise RuntimeError("请先停止运行中的后端，再迁移创作工程；没有修改任何任务")
    for column in (
        sa.Column("brief", sa.Text(), nullable=False, server_default=""),
        sa.Column("lifecycle", sa.String(), nullable=False, server_default="active"),
        sa.Column("aspect_width", sa.Integer()),
        sa.Column("aspect_height", sa.Integer()),
        sa.Column("target_duration_ms", sa.BigInteger()),
        sa.Column("language", sa.String()),
        sa.Column("style_brief", sa.Text(), nullable=False, server_default=""),
        sa.Column("creation_key", sa.String()),
        sa.Column("creation_hash", sa.String()),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ):
        op.add_column("studio_projects", column)
    op.create_unique_constraint("uq_studio_project_owner", "studio_projects", ["id", "owner"])
    op.create_unique_constraint(
        "uq_studio_project_creation", "studio_projects", ["owner", "creation_key"]
    )
    op.create_unique_constraint("uq_studio_job_project", "studio_media_jobs", ["project", "id"])
    op.create_check_constraint(
        "ck_studio_project_lifecycle", "studio_projects", "lifecycle IN ('active','archived')"
    )
    op.create_check_constraint(
        "ck_studio_project_aspect",
        "studio_projects",
        "(aspect_width IS NULL AND aspect_height IS NULL) OR "
        "(aspect_width IS NOT NULL AND aspect_height IS NOT NULL "
        "AND aspect_width > 0 AND aspect_height > 0)",
    )
    op.create_check_constraint(
        "ck_studio_project_duration",
        "studio_projects",
        "target_duration_ms IS NULL OR target_duration_ms > 0",
    )
    schema = json.loads(
        (Path(__file__).parents[1] / "data/studio_foundation_schema.json").read_text(
            encoding="utf-8"
        )
    )
    for statement in schema["statements"]:
        op.execute(sa.text(statement))
    op.rename_table("studio_assets", "studio_assets_legacy")
    migrate_assets(connection)
    op.execute(ASSET_VIEW)
    migrate_projects(connection)
    upgrade_navigation(connection)
    for permission in (
        "studio.projects.read",
        "studio.projects.write",
        "studio.assets.read",
        "studio.assets.write",
    ):
        connection.execute(
            sa.text(
                "UPDATE roles SET permissions=permissions || jsonb_build_array(:permission) WHERE permissions ? 'products.entertainment' AND NOT permissions ? :permission"
            ),
            {"permission": permission},
        )


def downgrade() -> None:
    raise RuntimeError("结构化工程可能已产生新版本；请按备份恢复流程回退，禁止丢弃当前作品")

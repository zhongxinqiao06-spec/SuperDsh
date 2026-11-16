"""创作工程、素材版本和媒体任务；既有角色继承办公入口。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "d593ef192aae"
down_revision = "c841f50b3ae2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "studio_model_defaults",
        sa.Column("capability", sa.String(), primary_key=True),
        sa.Column(
            "configuration_id",
            sa.String(),
            sa.ForeignKey("model_configurations.id"),
            nullable=False,
        ),
    )
    op.create_table(
        "studio_projects",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner", sa.String(), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("proposal", JSONB),
        sa.Column("session_id", sa.String(), unique=True),
        sa.Column(
            "updated", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_table(
        "studio_revisions",
        sa.Column("project", sa.String(), sa.ForeignKey("studio_projects.id"), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("document", JSONB, nullable=False),
        sa.Column("label", sa.String(), nullable=False),
    )
    op.create_table(
        "studio_assets",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("family", sa.String(), nullable=False, index=True),
        sa.Column("owner", sa.String(), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("project", sa.String(), sa.ForeignKey("studio_projects.id")),
        sa.Column("parent", sa.String(), sa.ForeignKey("studio_assets.id")),
        sa.Column("definition", JSONB, nullable=False),
    )
    op.create_table(
        "studio_media_jobs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "project", sa.String(), sa.ForeignKey("studio_projects.id"), nullable=False, index=True
        ),
        sa.Column("request_key", sa.String(), nullable=False),
        sa.Column("subject", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(), nullable=False, index=True),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("provider_id", sa.String()),
        sa.Column("error", sa.String()),
        sa.Column(
            "updated", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("project", "request_key", "subject"),
    )
    op.execute("""UPDATE roles SET permissions = permissions || '["products.office"]'::jsonb
                  WHERE NOT permissions ? 'products.office'""")
    op.execute("""UPDATE roles SET permissions = permissions || '["products.entertainment"]'::jsonb
                  WHERE id = 'admin' AND NOT permissions ? 'products.entertainment'""")


def downgrade() -> None:
    op.execute(
        "UPDATE roles SET permissions = permissions - 'products.office' - 'products.entertainment'"
    )
    for name in (
        "studio_model_defaults",
        "studio_media_jobs",
        "studio_assets",
        "studio_revisions",
        "studio_projects",
    ):
        op.drop_table(name)

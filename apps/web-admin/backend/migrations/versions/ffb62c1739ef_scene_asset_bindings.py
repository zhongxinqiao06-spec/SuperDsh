"""场次默认场景与镜头覆盖保持明确的不可变版本引用。"""

import sqlalchemy as sa
from alembic import op

revision = "ffb62c1739ef"
down_revision = "fea51b0628de"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("studio_clips", sa.Column("effect_id", sa.String(), nullable=True))
    op.execute(
        "INSERT INTO studio_tracks(project_id, id, kind, position) SELECT project_id, 'sound', 'sound', 4 FROM studio_timelines"
    )
    for table in ("studio_story_scenes", "studio_shots"):
        op.add_column(table, sa.Column("scene_asset_id", sa.String(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_scene_asset", table, "studio_entity_versions", ["scene_asset_id"], ["id"]
        )


def downgrade() -> None:
    op.execute("DELETE FROM studio_clips WHERE track_id='sound'")
    op.execute("DELETE FROM studio_tracks WHERE id='sound'")
    op.drop_column("studio_clips", "effect_id")
    for table in ("studio_shots", "studio_story_scenes"):
        op.drop_constraint(f"fk_{table}_scene_asset", table, type_="foreignkey")
        op.drop_column(table, "scene_asset_id")

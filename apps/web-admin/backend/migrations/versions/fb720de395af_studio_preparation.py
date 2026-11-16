"""创作准备确认、三方草案与声音绑定投影。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "fb720de395af"
down_revision = "fa619c2d804e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "studio_stage_reviews",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("studio_projects.id"), nullable=False),
        sa.Column("stage", sa.String(), nullable=False),
        sa.Column("project_revision", sa.Integer(), nullable=False),
        sa.Column("input_hash", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("selections", JSONB(), nullable=False),
        sa.Column("actor_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("stage IN ('script','cast','storyboard','sample')"),
        sa.CheckConstraint("decision IN ('confirmed','skipped')"),
        sa.CheckConstraint("project_revision > 0"),
    )
    op.create_index("ix_studio_stage_reviews_project_id", "studio_stage_reviews", ["project_id"])
    op.create_table(
        "studio_proposals",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("studio_projects.id"), nullable=False),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("request_key", sa.String(), nullable=False),
        sa.Column("request_hash", sa.String(), nullable=False),
        sa.Column("base_document", JSONB(), nullable=False),
        sa.Column("proposed_document", JSONB(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("resolution", JSONB()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "request_key"),
        sa.CheckConstraint("state IN ('pending','reviewed')"),
        sa.CheckConstraint("base_revision > 0"),
    )
    op.create_index("ix_studio_proposals_project_id", "studio_proposals", ["project_id"])
    op.execute("""CREATE OR REPLACE VIEW studio_assets AS
        SELECT v.id, e.id AS family, e.owner_id AS owner, e.project_id AS project,
          v.origin_version_id AS parent,
          jsonb_build_object('kind',e.kind,'name',v.name,'description',v.description,
            'voice',v.voice_id,'voiceBinding',CASE WHEN v.voice_configuration_id IS NULL THEN NULL ELSE
              jsonb_build_object('configurationId',v.voice_configuration_id,'revision',v.voice_configuration_revision,'capability','speech.synthesize') END,
            'voicePreviewJob',v.voice_parameters->>'previewJob',
            'fileId',(SELECT a.file_id FROM studio_entity_version_assets r
              JOIN studio_asset_versions a ON a.id=r.asset_version_id WHERE r.entity_version_id=v.id ORDER BY r.position,r.asset_version_id LIMIT 1),
            'sourceJob',NULL,'entityId',e.id,'version',v.version_no) AS definition
        FROM studio_entity_versions v JOIN studio_entities e ON e.id=v.entity_id
        UNION ALL SELECT v.id,f.id,f.owner_id,f.project_id,v.parent_version_id,
          jsonb_build_object('kind',f.kind,'name',v.name,'description',v.description,'voice','',
            'fileId',v.file_id,'sourceJob',v.source_job_id,'version',v.version_no)
        FROM studio_asset_versions v JOIN studio_asset_families f ON f.id=v.family_id""")


def downgrade() -> None:
    raise RuntimeError("请使用升级前备份恢复，不能丢弃用户的创作确认记录")

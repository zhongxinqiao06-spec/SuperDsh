"""补齐已执行早期素材库迁移的数据库，保留作品、修订、媒体和逐字段基线。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "00784e395b01"
down_revision = "00673d284af0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """早期开发库已记账但缺后补字段；用新 revision 修复，不能依赖重跑旧文件。"""
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    for table, additions in (
        (
            "studio_asset_versions",
            [sa.Column(name, sa.Integer()) for name in ("duration_ms", "width", "height")],
        ),
        ("studio_clips", [sa.Column("effect_id", sa.String(), nullable=True)]),
        (
            "studio_library_bindings",
            [
                sa.Column(
                    "field_versions", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
                )
            ],
        ),
    ):
        existing = {item["name"] for item in inspector.get_columns(table)}
        for column in additions:
            if column.name not in existing:
                op.add_column(table, column)

    # 空字典沿用绑定原有 imported/published 版本基线，不推断或改写已采用字段。
    op.execute(
        "UPDATE studio_library_bindings SET field_versions='{}'::jsonb WHERE field_versions IS NULL"
    )
    op.alter_column("studio_library_bindings", "field_versions", nullable=False)
    op.execute(
        "INSERT INTO studio_tracks(project_id,id,kind,position) "
        "SELECT project_id,'sound','sound',4 FROM studio_timelines "
        "ON CONFLICT (project_id,id) DO NOTHING"
    )
    # 冻结当前视图契约：角色封面只取形象引用，试听独立返回；不修改任何素材行。
    op.execute("""CREATE OR REPLACE VIEW studio_assets AS
        SELECT v.id, e.id AS family, e.owner_id AS owner, e.project_id AS project,
          v.origin_version_id AS parent,
          jsonb_build_object('kind',e.kind,'name',v.name,'description',v.description,
            'voice',v.voice_id,'voiceBinding',CASE WHEN v.voice_configuration_id IS NULL THEN NULL ELSE
              jsonb_build_object('configurationId',v.voice_configuration_id,'revision',v.voice_configuration_revision,'capability','speech.synthesize') END,
            'voicePreviewJob',v.voice_parameters->>'previewJob',
            'voicePreviewAssetId',(SELECT r.asset_version_id FROM studio_entity_version_assets r
              WHERE r.entity_version_id=v.id AND r.purpose='voice-preview' ORDER BY r.position,r.asset_version_id LIMIT 1),
            'fileId',(SELECT a.file_id FROM studio_entity_version_assets r
              JOIN studio_asset_versions a ON a.id=r.asset_version_id WHERE r.entity_version_id=v.id
                AND r.purpose='reference' ORDER BY r.position,r.asset_version_id LIMIT 1),
            'sourceJob',NULL,'entityId',e.id,'version',v.version_no) AS definition
        FROM studio_entity_versions v JOIN studio_entities e ON e.id=v.entity_id
        UNION ALL SELECT v.id,f.id,f.owner_id,f.project_id,v.parent_version_id,
          jsonb_build_object('kind',f.kind,'name',v.name,'description',v.description,'voice','',
            'fileId',v.file_id,'sourceJob',v.source_job_id,'version',v.version_no)
        FROM studio_asset_versions v JOIN studio_asset_families f ON f.id=v.family_id""")


def downgrade() -> None:
    """父 revision 的正式契约也需要这些字段，回退修复标记不删除用户数据。"""

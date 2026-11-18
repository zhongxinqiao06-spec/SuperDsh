"""素材库聚合身份、独立造型、作品来源绑定与可重试的收藏引用。"""

from uuid import NAMESPACE_URL, uuid5

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "fea51b0628de"
down_revision = "fd940fa517cd"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for field in ("duration_ms", "width", "height"):
        op.add_column("studio_asset_versions", sa.Column(field, sa.Integer()))
    op.create_table(
        "studio_entity_variants",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("entity_id", sa.String(), sa.ForeignKey("studio_entities.id"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column(
            "current_version_id",
            sa.String(),
            sa.ForeignKey("studio_entity_versions.id", deferrable=True, initially="DEFERRED"),
            nullable=False,
        ),
        sa.UniqueConstraint("entity_id", "name"),
    )
    op.create_index("ix_studio_entity_variants_entity_id", "studio_entity_variants", ["entity_id"])
    op.add_column(
        "studio_entity_versions",
        sa.Column("variant_id", sa.String(), sa.ForeignKey("studio_entity_variants.id")),
    )
    op.create_index(
        "ix_studio_entity_versions_variant_id", "studio_entity_versions", ["variant_id"]
    )
    connection = op.get_bind()
    for entity in connection.execute(
        sa.text("SELECT id, kind, current_version_id FROM studio_entities")
    ).mappings():
        identity = uuid5(NAMESPACE_URL, f"superdsh/studio/{entity['id']}/default-variant").hex
        connection.execute(
            sa.text(
                "INSERT INTO studio_entity_variants (id,entity_id,name,current_version_id) VALUES (:id,:entity,:name,:version)"
            ),
            {
                "id": identity,
                "entity": entity["id"],
                "name": "默认造型" if entity["kind"] == "character" else "默认设定",
                "version": entity["current_version_id"],
            },
        )
        connection.execute(
            sa.text(
                "UPDATE studio_entity_versions SET variant_id=:variant WHERE entity_id=:entity"
            ),
            {"variant": identity, "entity": entity["id"]},
        )
    op.create_table(
        "studio_library_bindings",
        sa.Column("project_id", sa.String(), sa.ForeignKey("studio_projects.id"), primary_key=True),
        sa.Column("project_family_id", sa.String(), primary_key=True),
        sa.Column("project_variant_id", sa.String(), primary_key=True),
        sa.Column("owner_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("library_family_id", sa.String(), nullable=False),
        sa.Column("imported_version_id", sa.String()),
        sa.Column("published_version_id", sa.String()),
        sa.Column("project_version_id", sa.String(), nullable=False),
        sa.Column("field_versions", JSONB(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_index("ix_studio_library_bindings_owner_id", "studio_library_bindings", ["owner_id"])
    op.create_index(
        "ix_studio_library_bindings_library_family_id",
        "studio_library_bindings",
        ["library_family_id"],
    )
    op.create_table(
        "studio_library_operations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_key", sa.String(100), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("result", JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("owner_id", "request_key"),
    )
    # 音色试听和造型参考是独立用途；不能因新增音频引用让角色封面指向 WAV 文件。
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
    op.drop_table("studio_library_operations")
    op.drop_table("studio_library_bindings")
    op.drop_column("studio_entity_versions", "variant_id")
    op.drop_table("studio_entity_variants")
    for field in ("height", "width", "duration_ms"):
        op.drop_column("studio_asset_versions", field)

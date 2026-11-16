"""分产品保存模型默认配置和管理素材，保留已有娱乐设置与个人资产。"""

import sqlalchemy as sa
from alembic import op

revision = "f28d6419b037"
down_revision = "e821cf49a5d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_model_defaults",
        sa.Column("product", sa.String(32), primary_key=True),
        sa.Column("capability", sa.String(), primary_key=True),
        sa.Column(
            "configuration_id",
            sa.String(),
            sa.ForeignKey("model_configurations.id"),
            nullable=False,
        ),
    )
    op.execute("""INSERT INTO product_model_defaults (product, capability, configuration_id)
                  SELECT 'entertainment', capability, configuration_id FROM studio_model_defaults""")
    op.drop_table("studio_model_defaults")
    op.add_column(
        "agent_assets",
        sa.Column("product", sa.String(32), nullable=False, server_default="personal"),
    )
    for constraint in sa.inspect(op.get_bind()).get_unique_constraints("agent_assets"):
        if constraint["column_names"] == ["owner_id", "kind", "name", "sha256"]:
            name = constraint["name"]
            if not name:
                raise RuntimeError("资产去重约束缺少名称，无法安全迁移")
            op.drop_constraint(name, "agent_assets", type_="unique")
    op.create_unique_constraint(
        "uq_agent_asset_product_content",
        "agent_assets",
        ["owner_id", "product", "kind", "name", "sha256"],
    )


def downgrade() -> None:
    op.create_unique_constraint(
        "uq_agent_asset_content", "agent_assets", ["owner_id", "kind", "name", "sha256"]
    )
    op.drop_constraint("uq_agent_asset_product_content", "agent_assets", type_="unique")
    op.drop_column("agent_assets", "product")
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
    op.execute("""INSERT INTO studio_model_defaults (capability, configuration_id)
                  SELECT capability, configuration_id FROM product_model_defaults WHERE product='entertainment'""")
    op.drop_table("product_model_defaults")

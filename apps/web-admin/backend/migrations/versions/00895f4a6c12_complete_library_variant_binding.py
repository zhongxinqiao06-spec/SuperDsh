"""补齐早期作品素材绑定的造型身份，保留现有来源与逐字段基线。"""

import sqlalchemy as sa
from alembic import op

revision = "00895f4a6c12"
down_revision = "00784e395b01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """仅从已绑定的项目版本恢复造型，不按名称匹配或更换作品素材。"""
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("studio_library_bindings")}
    if "project_variant_id" not in columns:
        op.add_column("studio_library_bindings", sa.Column("project_variant_id", sa.String()))
    op.execute("""UPDATE studio_library_bindings AS b
        SET project_variant_id=COALESCE(
          (SELECT v.variant_id FROM studio_entity_versions v WHERE v.id=b.project_version_id),'')
        WHERE b.project_variant_id IS NULL""")
    op.alter_column("studio_library_bindings", "project_variant_id", nullable=False)
    expected = ["project_id", "project_family_id", "project_variant_id"]
    primary = inspector.get_pk_constraint("studio_library_bindings")
    if primary["constrained_columns"] != expected:
        constraint_name = primary["name"]
        if constraint_name is None:
            raise RuntimeError("作品素材绑定缺少原有主键，拒绝猜测未知数据库结构")
        op.drop_constraint(constraint_name, "studio_library_bindings", type_="primary")
        op.create_primary_key(constraint_name, "studio_library_bindings", expected)


def downgrade() -> None:
    """旧正式契约同样包含造型维度；降级标记不合并或删除用户绑定。"""

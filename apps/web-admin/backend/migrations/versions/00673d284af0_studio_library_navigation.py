"""素材中心分为角色、场景、道具和媒体，保持既有菜单授权。"""

import sqlalchemy as sa
from alembic import op

from migrations.data.studio_library_navigation import library_navigation_items

revision = "00673d284af0"
down_revision = "ffb62c1739ef"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """对持久菜单逐字段升级，空库由应用读取新默认目录。"""
    connection = op.get_bind()
    source = connection.execute(
        sa.text("SELECT items FROM navigation_settings WHERE id='entertainment' FOR UPDATE")
    ).scalar_one_or_none()
    if source is None:
        return
    items = library_navigation_items(source)
    if items != source:
        connection.execute(
            sa.text(
                "UPDATE navigation_settings SET items=:items,version=version+1 WHERE id='entertainment'"
            ).bindparams(sa.bindparam("items", type_=sa.JSON)),
            {"items": items},
        )


def downgrade() -> None:
    raise RuntimeError("菜单可能已被管理员编辑；请从备份恢复，避免覆盖当前授权与自定义分组")

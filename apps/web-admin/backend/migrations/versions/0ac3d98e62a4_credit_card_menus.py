"""为已保存的产品菜单增加额度卡管理及本人额度卡，继承原入口的可见范围。"""

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0ac3d98e62a4"
down_revision = "09b6c14a83df"
branch_labels = None
depends_on = None


def add_card_menus(items: list[dict[str, Any]]) -> bool:
    """保留已有分组、角色和隐藏配置；遇到同名自定义分组时同步修订其子项引用。"""
    changed = False
    for anchor, key, title in [
        ("billing.subscriptions", "billing.cards", "额度卡管理"),
        ("account.membership", "account.cards", "我的额度卡"),
    ]:
        source = next((i for i in items if i["moduleId"] == anchor), None)
        if source is None or any(i["moduleId"] == key for i in items):
            continue
        occupied = {i["id"] for i in items}
        if key in occupied:
            suffix = 1
            while f"{key}-{suffix}" in occupied:
                suffix += 1
            for node in items:
                for field in ("id", "parentId"):
                    if node[field] == key:
                        node[field] = f"{key}-{suffix}"
        order = max(i["order"] for i in items if i["parentId"] == source["parentId"])
        items.append(
            {
                **source,
                "id": key,
                "moduleId": key,
                "title": title,
                "icon": "box",
                "order": min(order + 1, 10000),
            }
        )
        changed = True
    return changed


def upgrade() -> None:
    conn = op.get_bind()
    update = sa.text(
        "UPDATE navigation_settings SET items=:items,version=version+1 WHERE id=:id"
    ).bindparams(sa.bindparam("items", type_=JSONB))
    for key, items in conn.execute(
        sa.text(
            "SELECT id,items FROM navigation_settings WHERE id IN ('global','entertainment') ORDER BY id FOR UPDATE"
        )
    ).all():
        if not isinstance(items, list):
            raise ValueError("产品菜单必须是 JSON 数组")
        if add_card_menus(items):
            conn.execute(update, {"id": key, "items": items})


def downgrade() -> None:
    raise RuntimeError("请从升级前的导航备份恢复自定义菜单")

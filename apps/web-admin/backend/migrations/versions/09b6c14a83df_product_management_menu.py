"""将两个产品已保存的账号、会员和定价入口移入产品管理。"""

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "09b6c14a83df"
down_revision = "080dabc329f1"
branch_labels = None
depends_on = None

PAGES = ("access.users", "billing.subscriptions", "billing.plans", "billing.rates")


def move_pages(items: list[dict[str, Any]]) -> bool:
    """仅迁移原分组中的入口，保留自定义父级和原分组的角色、隐藏限制。"""
    by_id = {item["id"]: item for item in items}
    source = by_id.get("platform")
    dest = by_id.get("product-management")
    if not source or not dest or source["kind"] != "group" or dest["kind"] != "group":
        return False
    if not source["visible"] or source["roleIds"]:
        return False
    moving = [
        by_id[key]
        for key in PAGES
        if key in by_id and by_id[key]["moduleId"] == key and by_id[key]["parentId"] == source["id"]
    ]
    if not moving:
        return False
    siblings = [item for item in items if item["parentId"] == dest["id"]]
    start = max((item["order"] for item in siblings), default=-1) + 1
    if start + len(moving) - 1 > 10000:
        # 自定义顺序已使用上限时，仅压紧目标组，保留原有兄弟的显示顺序。
        for index, item in enumerate(sorted(siblings, key=lambda i: (i["order"], i["id"]))):
            item["order"] = index
        start = len(siblings)
    for index, item in enumerate(moving, start):
        item.update(parentId=dest["id"], order=index)
    return True


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, items FROM navigation_settings "
            "WHERE id IN ('global', 'entertainment') ORDER BY id FOR UPDATE"
        )
    ).all()
    update = sa.text(
        "UPDATE navigation_settings SET items=:items, version=version+1 WHERE id=:id"
    ).bindparams(sa.bindparam("items", type_=JSONB))
    for key, items in rows:
        if move_pages(items):
            conn.execute(update, {"id": key, "items": items})


def downgrade() -> None:
    raise RuntimeError("回退菜单请恢复升级前保存的导航配置，以保留自定义位置和排序")

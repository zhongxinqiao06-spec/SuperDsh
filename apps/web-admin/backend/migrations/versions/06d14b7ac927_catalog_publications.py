"""保留所有既有商品版本，增加发布与撤回凭据，接入套餐维护入口。"""

import sqlalchemy as sa
from alembic import op

revision = "06d14b7ac927"
down_revision = "05bf27eafb26"
branch_labels = None
depends_on = None


def upgrade() -> None:
    table = "billing_plan_versions"
    for stem, action in [("published", "publish"), ("withdrawn", "withdraw")]:
        op.add_column(table, sa.Column(stem + "_at", sa.DateTime(timezone=True)))
        op.add_column(table, sa.Column(stem + "_by", sa.String(80), sa.ForeignKey("users.id")))
        op.add_column(table, sa.Column(action + "_key", sa.String(36)))
        op.add_column(table, sa.Column(action + "_reason", sa.String(300)))
        op.create_unique_constraint(
            "uq_plan_" + action + "_key", table, [stem + "_by", action + "_key"]
        )
    op.create_check_constraint(
        "ck_plan_publish_evidence",
        table,
        "num_nonnulls(published_at,published_by,publish_key,publish_reason) IN (0,4) "
        "AND (published_at IS NULL OR published_at <= effective_at)",
    )
    op.create_check_constraint(
        "ck_plan_withdraw_evidence",
        table,
        "num_nonnulls(withdrawn_at,withdrawn_by,withdraw_key,withdraw_reason) IN (0,4) "
        "AND (withdrawn_at IS NULL OR withdrawn_at < effective_at)",
    )
    conn = op.get_bind()
    conn.execute(
        sa.text("""UPDATE roles SET permissions=permissions || '["billing.plans.manage"]'::jsonb,
        revision=revision+1 WHERE id='admin' AND builtin AND NOT (permissions ? 'billing.plans.manage')""")
    )
    for product, items in conn.execute(
        sa.text(
            "SELECT id, items FROM navigation_settings WHERE id IN ('global','entertainment') FOR UPDATE"
        )
    ):
        if not isinstance(items, list):
            raise ValueError("已保存的菜单不是列表")
        anchor = next((i for i in items if i.get("moduleId") == "billing.subscriptions"), None)
        key = "billing.plans"
        if not anchor or any(i.get("moduleId") == key for i in items):
            continue
        used = {i["id"] for i in items}
        if key in used:
            n = 1
            while f"{key}-{n}" in used:
                n += 1
            for item in items:
                for field in ("id", "parentId"):
                    if item.get(field) == key:
                        item[field] = f"{key}-{n}"
        order = max(i["order"] for i in items if i.get("parentId") == anchor["parentId"])
        items.append(
            {
                **anchor,
                "id": key,
                "moduleId": key,
                "title": "套餐版本管理",
                "icon": "box",
                "order": min(10000, order + 1),
            }
        )
        conn.execute(
            sa.text(
                "UPDATE navigation_settings SET items=:items,version=version+1 WHERE id=:id"
            ).bindparams(sa.bindparam("items", type_=sa.JSON)),
            {"id": product, "items": items},
        )


def downgrade() -> None:
    raise RuntimeError("发布历史和既有办理单有关联，请使用升级前备份恢复")

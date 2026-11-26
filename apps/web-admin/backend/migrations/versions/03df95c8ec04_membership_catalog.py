"""发布试行商品并为两个产品接入个人额度入口。"""

from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "03df95c8ec04"
down_revision = "02ce84b7dbf3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    plans = op.create_table(
        "billing_plan_versions",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("sku", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("term_unit", sa.String(16), nullable=False),
        sa.Column("price_fen", sa.Integer, nullable=False),
        sa.Column("points", sa.Integer, nullable=False),
        sa.Column("listed", sa.Boolean, nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("sku", "revision"),
        sa.UniqueConstraint("id", "kind"),
        sa.CheckConstraint("revision > 0 AND price_fen >= 0 AND points > 0"),
        sa.CheckConstraint("kind IN ('membership', 'addon') AND term_unit IN ('month', 'year')"),
    )
    now = datetime.now(UTC)
    op.bulk_insert(
        plans,
        [
            dict(
                id=sku + "-1",
                sku=sku,
                revision=1,
                name=name,
                kind=kind,
                term_unit=unit,
                price_fen=price,
                points=points,
                listed=True,
                effective_at=now,
            )
            for sku, name, kind, unit, price, points in [
                ("light", "轻享会员", "membership", "month", 2900, 300),
                ("creator", "创作会员", "membership", "month", 6900, 800),
                ("pro", "专业会员", "membership", "month", 19900, 2600),
                ("extra", "加购包", "addon", "year", 1900, 180),
            ]
        ],
    )
    op.create_table(
        "billing_subscriptions",
        sa.Column("user_id", sa.String(80), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("plan_version_id", sa.String(80), nullable=False),
        sa.Column("plan_kind", sa.String(16), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_grant_at", sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(
            ["plan_version_id", "plan_kind"],
            ["billing_plan_versions.id", "billing_plan_versions.kind"],
        ),
        sa.CheckConstraint("plan_kind = 'membership' AND starts_at < ends_at"),
        sa.CheckConstraint(
            "next_grant_at IS NULL OR (next_grant_at >= starts_at AND next_grant_at <= ends_at)"
        ),
    )

    connection = op.get_bind()
    for product, items in connection.execute(
        sa.text(
            "SELECT id, items FROM navigation_settings WHERE id IN ('global','entertainment') FOR UPDATE"
        )
    ).all():
        if not isinstance(items, list):
            raise ValueError(f"产品 {product} 的已保存菜单不是列表")
        template = next((i for i in items if i.get("moduleId") == "account.profile"), None)
        if not template or any(i.get("moduleId") == "account.membership" for i in items):
            continue
        # 新模块标识可能原先用作自定义分组名；重命名该组同时保留所有父子关系。
        occupied = {i["id"] for i in items}
        for item in items:
            if item["kind"] == "group" and item["id"] in {"account.membership", "account.plans"}:
                old = item["id"]
                suffix = 1
                while (new := f"{old}-{suffix}") in occupied:
                    suffix += 1
                item["id"] = new
                occupied.add(new)
                for child in items:
                    if child.get("parentId") == old:
                        child["parentId"] = new
        siblings = [i["order"] for i in items if i.get("parentId") == template["parentId"]]
        items.append(
            {
                **template,
                "id": "account.membership",
                "moduleId": "account.membership",
                "title": "我的会员与额度",
                "icon": "gauge",
                "order": min(10000, max(siblings) + 1),
            }
        )
        connection.execute(
            sa.text(
                "UPDATE navigation_settings SET items=:items, version=version+1 WHERE id=:product"
            ).bindparams(sa.bindparam("items", type_=sa.JSON)),
            {"items": items, "product": product},
        )


def downgrade() -> None:
    raise RuntimeError("会员记录与自定义菜单可能已变更，请从升级前备份恢复")

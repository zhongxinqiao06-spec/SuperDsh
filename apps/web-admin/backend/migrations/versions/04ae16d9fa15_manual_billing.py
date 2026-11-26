"""人工会员办理、收款凭证去重与月度生效批次。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "04ae16d9fa15"
down_revision = "03df95c8ec04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "billing_operations",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("user_id", sa.String(80), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("actor_id", sa.String(80), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("business_key", sa.String(80), nullable=False),
        sa.Column("request", JSONB, nullable=False),
        sa.Column("quote", JSONB, nullable=False),
        sa.Column("receipt", sa.String(120), unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("actor_id", "business_key"),
        sa.UniqueConstraint("user_id", "id"),
    )
    op.create_index("ix_billing_op_owner_time", "billing_operations", ["user_id", "confirmed_at"])
    op.create_table(
        "billing_periods",
        sa.Column("operation_id", sa.String(80), primary_key=True),
        sa.Column("user_id", sa.String(80), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "plan_version_id",
            sa.String(80),
            sa.ForeignKey("billing_plan_versions.id"),
            nullable=False,
        ),
        sa.Column(
            "lot_id",
            sa.String(80),
            unique=True,
            nullable=False,
        ),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "starts_at"),
        sa.ForeignKeyConstraint(
            ["user_id", "operation_id"], ["billing_operations.user_id", "billing_operations.id"]
        ),
        sa.ForeignKeyConstraint(
            ["user_id", "lot_id"], ["billing_credit_lots.user_id", "billing_credit_lots.id"]
        ),
        sa.CheckConstraint("ends_at > starts_at"),
    )
    conn = op.get_bind()
    # 只有不可编辑的内置平台管理员自动获得财务权限，自定义角色维持原授权。
    conn.execute(
        sa.text("""UPDATE roles SET permissions=permissions ||
        '["billing.read","billing.subscriptions.manage","billing.adjustments.create","billing.receipts.record"]'::jsonb,
        revision=revision+1 WHERE id='admin' AND builtin""")
    )
    for product, items in conn.execute(
        sa.text(
            "SELECT id,items FROM navigation_settings WHERE id IN ('global','entertainment') FOR UPDATE"
        )
    ).all():
        if not isinstance(items, list):
            raise ValueError("已保存的菜单不是列表")
        anchor = next((i for i in items if i.get("moduleId") == "access.users"), None)
        if not anchor or any(i.get("moduleId") == "billing.subscriptions" for i in items):
            continue
        key = "billing.subscriptions"
        existing = {i["id"] for i in items}
        if key in existing:
            n = 1
            while f"{key}-{n}" in existing:
                n += 1
            for i in items:
                for field in ("id", "parentId"):
                    if i.get(field) == key:
                        i[field] = f"{key}-{n}"
        order = max(i["order"] for i in items if i.get("parentId") == anchor["parentId"])
        items.append(
            {
                **anchor,
                "id": key,
                "moduleId": key,
                "title": "会员记录与办理",
                "icon": "gauge",
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
    raise RuntimeError("已确认的会员周期、实收及授权需要保留，请通过升级前备份恢复")

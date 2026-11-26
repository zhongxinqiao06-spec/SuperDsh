"""定价草稿、发布历史与任务报价。既有办理单和任务保持原记录。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "07f392be164c"
down_revision = "06d14b7ac927"
branch_labels = None
depends_on = None


def upgrade() -> None:
    versions = op.create_table(
        "billing_pricing_versions",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("domain", sa.String(8), nullable=False),
        sa.Column("scope", sa.String(420), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("actor", sa.String(80), sa.ForeignKey("users.id")),
        sa.Column("business_key", sa.String(36)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True)),
        sa.Column("published_by", sa.String(80), sa.ForeignKey("users.id")),
        sa.Column("publication", JSONB),
        sa.UniqueConstraint("actor", "business_key"),
        sa.UniqueConstraint("domain", "scope", "revision"),
        sa.CheckConstraint("domain IN ('plan','rate') AND revision > 0"),
    )
    op.create_index(
        "ix_pricing_effective", "billing_pricing_versions", ["domain", "scope", "effective_at"]
    )
    op.create_table(
        "billing_usage_quotes",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("owner", sa.String(80), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_key", sa.String(90), nullable=False),
        sa.Column("source", sa.String(160), nullable=False),
        sa.Column("snapshot", JSONB, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("owner", "request_key"),
    )
    # 明确列出试行规格，同一能力的其他规格需运营先建立费率。
    for product, capability, spec, unit, size, points in [
        ("entertainment", "video.generate", "720P", "second", 1, 20),
        ("entertainment", "image.generate", "standard", "image", 1, 10),
        ("entertainment", "speech.synthesize", "standard", "character", 100, 2),
        ("office", "text.generate", "short", "call", 1, 5),
        ("office", "image.generate", "standard", "image", 1, 10),
        ("office", "image.analyze", "standard", "image", 1, 3),
        ("office", "search", "standard", "call", 1, 5),
    ]:
        for payer in ("platform", "personal"):
            scope = "|".join((product, capability, "*", "0", spec, payer))
            terms = dict(
                product=product,
                capability=capability,
                model="*",
                modelRevision=0,
                spec=spec,
                payer=payer,
                unit=unit,
                unitSize=size,
                unitPoints=points if payer == "platform" else 0,
            )
            op.get_bind().execute(
                versions.insert().values(
                    id=f"{product}-{capability}-{payer}-1",
                    domain="rate",
                    scope=scope,
                    revision=1,
                    payload={"terms": terms, "reason": "试行费率"},
                    created_at=sa.func.now(),
                    effective_at=sa.func.now(),
                )
            )
    conn = op.get_bind()
    conn.execute(
        sa.text("""UPDATE roles SET permissions=permissions || '["billing.rates.manage"]'::jsonb,
        revision=revision+1 WHERE id='admin' AND builtin AND NOT (permissions ? 'billing.rates.manage')""")
    )
    for product_id, items in conn.execute(
        sa.text(
            "SELECT id, items FROM navigation_settings WHERE id IN ('global','entertainment') FOR UPDATE"
        )
    ):
        if not isinstance(items, list):
            raise ValueError("已保存的菜单不是列表")
        anchor = next((i for i in items if i.get("moduleId") == "billing.plans"), None)
        key = "billing.rates"
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
                "title": "模型扣点价目",
                "icon": "box",
                "order": min(10000, order + 1),
            }
        )
        conn.execute(
            sa.text(
                "UPDATE navigation_settings SET items=:items,version=version+1 WHERE id=:id"
            ).bindparams(sa.bindparam("items", type_=sa.JSON)),
            {"id": product_id, "items": items},
        )


def downgrade() -> None:
    raise RuntimeError("历史任务已引用报价，请使用升级前备份恢复")

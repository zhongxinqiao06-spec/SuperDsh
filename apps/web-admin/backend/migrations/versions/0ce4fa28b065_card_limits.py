"""卡种、发放快照、首次登录提示和会员周月限额。"""

import sqlalchemy as sa
from alembic import op

revision = "0ce4fa28b065"
down_revision = "0bd3ec17af54"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "billing_card_images",
        sa.Column("digest", sa.String(64), primary_key=True),
        sa.Column("content", sa.LargeBinary(), nullable=False),
    )
    op.create_table(
        "billing_card_types",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("valid_days", sa.Integer(), nullable=False),
        sa.Column("image", sa.String(180), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "points BETWEEN 1 AND 1000000 AND valid_days BETWEEN 1 AND 3650 AND revision > 0"
        ),
    )
    for key, name, points in [
        ("film", "胶片卡", 100),
        ("slate", "场记卡", 200),
        ("lens", "取景卡", 500),
        ("spotlight", "聚光卡", 1000),
        ("projector", "放映卡", 2000),
    ]:
        op.get_bind().execute(
            sa.text("INSERT INTO billing_card_types VALUES (:key,:name,:points,365,:image,true,1)"),
            dict(key=key, name=name, points=points, image=f"/images/credit-cards/{key}.webp"),
        )
    op.add_column("billing_credit_lots", sa.Column("card_name", sa.String(80)))
    op.add_column("billing_credit_lots", sa.Column("card_image", sa.String(180)))
    op.add_column("billing_credit_lots", sa.Column("weekly_limit", sa.Integer()))
    op.add_column("billing_credit_lots", sa.Column("monthly_limit", sa.Integer()))
    op.add_column("billing_credit_lots", sa.Column("notice_seen_at", sa.DateTime(timezone=True)))
    op.add_column("billing_plan_versions", sa.Column("weekly_points", sa.Integer()))
    op.execute(
        "UPDATE billing_credit_lots l SET card_name=c.name,card_image=c.image FROM billing_card_types c WHERE l.source_key LIKE 'card:%' AND l.granted=c.points"
    )
    # 原单及原扣款保留，以调整流水补记生效中和预购批次的净变动。
    op.execute("""UPDATE billing_plan_versions SET
          weekly_points=CASE sku WHEN 'light' THEN 200 WHEN 'creator' THEN 500 WHEN 'pro' THEN 1000 ELSE points END,
          points=CASE sku WHEN 'light' THEN 500 WHEN 'creator' THEN 1500 WHEN 'pro' THEN 3000 ELSE points END
        WHERE kind='membership'""")
    op.execute("""
        WITH terms AS (
          SELECT l.id,p.weekly_points,p.points,greatest(l.granted-l.remaining+l.held,
                p.points * CASE p.term_unit WHEN 'year' THEN 12 ELSE 1 END) AS target,l.granted AS old_total
          FROM billing_periods s JOIN billing_plan_versions p ON p.id=s.plan_version_id
            JOIN billing_credit_lots l ON l.id=s.lot_id WHERE s.ends_at>CURRENT_TIMESTAMP
        ), upgraded AS (
          UPDATE billing_credit_lots l SET weekly_limit=t.weekly_points,monthly_limit=t.points,
            granted=t.target,remaining=l.remaining+(t.target-t.old_total) FROM terms t WHERE t.id=l.id
          RETURNING l.id,l.user_id,l.created_at,t.target-t.old_total AS delta
        )
        INSERT INTO billing_ledger_entries(id,user_id,lot_id,event_key,kind,available_delta,held_delta,created_at)
        SELECT gen_random_uuid()::text,user_id,id,'member_quota_upgrade','member_quota_upgrade',delta,0,greatest(created_at,CURRENT_TIMESTAMP)
        FROM upgraded WHERE delta<>0""")
    op.create_index(
        "ix_member_usage_window",
        "billing_ledger_entries",
        ["lot_id", "created_at"],
        postgresql_where=sa.text("kind='usage_hold'"),
    )
    # 会员月以原始生效日为锚。释放以对应预留的原周回补，不能把额度带到下周。
    op.execute("""CREATE FUNCTION billing_member_quota(l billing_credit_lots,t timestamptz)
    RETURNS TABLE(weekly_remaining int,monthly_remaining int,week_ends_at timestamptz,month_ends_at timestamptz)
    LANGUAGE sql STABLE SET timezone='UTC' AS $$
      WITH nominal AS (SELECT (extract(year from t)::int-extract(year from l.created_at)::int)*12
             +extract(month from t)::int-extract(month from l.created_at)::int AS n),
      idx AS (SELECT n-CASE WHEN l.created_at+make_interval(months=>n)>t THEN 1 ELSE 0 END AS n FROM nominal),
      months AS (SELECT l.created_at+make_interval(months=>n) AS ms,
               least(l.expires_at,l.created_at+make_interval(months=>n+1)) AS me FROM idx),
      windows AS (SELECT ms,me,date_bin(interval '7 days',t,ms) AS ws FROM months),
      spending AS (
        SELECT coalesce(sum(h.held_delta) FILTER(WHERE h.created_at>=w.ws),0) AS weekly,
               coalesce(sum(h.held_delta),0) AS monthly
        FROM windows w JOIN billing_ledger_entries h ON h.lot_id=l.id AND h.user_id=l.user_id
         AND h.kind='usage_hold' AND h.created_at>=w.ms AND h.created_at<=t
        WHERE NOT EXISTS(SELECT 1 FROM billing_ledger_entries r
          WHERE r.user_id=h.user_id AND r.lot_id=h.lot_id AND r.event_key='finish:' || substr(h.event_key,9)
            AND r.kind='usage_release' AND r.created_at<=t))
      SELECT greatest(0,l.weekly_limit-s.weekly)::int,
             greatest(0,least(l.remaining-l.held,l.monthly_limit-s.monthly))::int,
             least(w.ws+interval '7 days',w.me),w.me FROM windows w CROSS JOIN spending s
    $$""")
    op.execute("""CREATE FUNCTION billing_spendable(l billing_credit_lots,t timestamptz) RETURNS integer
    LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN t<l.created_at OR t>=l.expires_at THEN 0 WHEN l.weekly_limit IS NULL THEN l.remaining-l.held
        ELSE (SELECT least(weekly_remaining,monthly_remaining) FROM billing_member_quota(l,t)) END
    $$""")


def downgrade() -> None:
    raise RuntimeError("额度卡可能已发放，请根据发布前备份回退")

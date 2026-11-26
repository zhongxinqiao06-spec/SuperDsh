"""为已按旧标准获赠 40 点的存量账号补发 160 点，保留原始账本。"""

from alembic import op

revision = "0bd3ec17af54"
down_revision = "0ac3d98e62a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 独立批次从补发日起有效 30 天；只采信原始注册流水，排除人工赠送和已注销用户。
    op.execute("""
        WITH issued AS (
          INSERT INTO billing_credit_lots
            (id, user_id, source_key, granted, remaining, held, created_at, expires_at)
          SELECT gen_random_uuid()::text, l.user_id, 'registration_supplement', 160, 160, 0,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '30 days'
          FROM billing_credit_lots l
          JOIN users u ON u.id=l.user_id AND u.deleted_at IS NULL
          WHERE l.source_key='registration' AND l.granted=40 AND EXISTS (
            SELECT 1 FROM billing_ledger_entries e
            WHERE e.user_id=l.user_id AND e.lot_id=l.id AND e.event_key='registration'
              AND e.kind='registration_grant' AND e.available_delta=40
          )
          ON CONFLICT (user_id, source_key) DO NOTHING
          RETURNING id,user_id,granted,created_at
        )
        INSERT INTO billing_ledger_entries
          (id,user_id,lot_id,event_key,kind,available_delta,held_delta,created_at)
        SELECT gen_random_uuid()::text,user_id,id,'registration_supplement',
               'registration_supplement',granted,0,created_at FROM issued
    """)


def downgrade() -> None:
    raise RuntimeError("已发放的注册补额可能已使用，需要保留原始账本。")

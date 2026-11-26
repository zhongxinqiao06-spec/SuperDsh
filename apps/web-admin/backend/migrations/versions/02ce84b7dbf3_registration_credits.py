"""记录公开注册来源及首笔创作点，不推断存量账号的邮箱验证与赠点资格。"""

import sqlalchemy as sa
from alembic import op

revision = "02ce84b7dbf3"
down_revision = "01bd73a6cae2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("registration_product", sa.String(20), nullable=True))
    op.create_check_constraint(
        "ck_users_registration_product",
        "users",
        "registration_product IN ('office','entertainment')",
    )
    op.create_table(
        "billing_wallets",
        sa.Column("user_id", sa.String(80), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "billing_credit_lots",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column(
            "user_id", sa.String(80), sa.ForeignKey("billing_wallets.user_id"), nullable=False
        ),
        sa.Column("source_key", sa.String(120), nullable=False),
        sa.Column("granted", sa.Integer(), nullable=False),
        sa.Column("remaining", sa.Integer(), nullable=False),
        sa.Column("held", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "source_key"),
        sa.UniqueConstraint("user_id", "id"),
        sa.CheckConstraint(
            "granted > 0 AND remaining >= 0 AND held >= 0 AND held <= remaining AND remaining <= granted"
        ),
    )
    op.create_index(
        "ix_billing_lots_owner_expiry", "billing_credit_lots", ["user_id", "expires_at"]
    )
    op.create_table(
        "billing_ledger_entries",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("user_id", sa.String(80), nullable=False),
        sa.Column("lot_id", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("event_key", sa.String(120), nullable=False),
        sa.Column("available_delta", sa.Integer(), nullable=False),
        sa.Column("held_delta", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id", "lot_id"], ["billing_credit_lots.user_id", "billing_credit_lots.id"]
        ),
        sa.UniqueConstraint("user_id", "event_key", "lot_id"),
    )
    op.create_index(
        "ix_billing_entries_owner_time", "billing_ledger_entries", ["user_id", "created_at", "id"]
    )


def downgrade() -> None:
    op.drop_table("billing_ledger_entries")
    op.drop_table("billing_credit_lots")
    op.drop_table("billing_wallets")
    op.drop_constraint("ck_users_registration_product", "users", type_="check")
    op.drop_column("users", "registration_product")

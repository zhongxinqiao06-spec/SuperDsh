"""为现有会员建立修订与换档记录，已购周期、凭证及账本保持原值。"""

import sqlalchemy as sa
from alembic import op

revision = "05bf27eafb26"
down_revision = "04ae16d9fa15"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "billing_subscriptions",
        sa.Column("revision", sa.Integer, server_default="1", nullable=False),
    )
    op.create_table(
        "billing_subscription_changes",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column(
            "user_id", sa.String(80), sa.ForeignKey("billing_subscriptions.user_id"), nullable=False
        ),
        sa.Column("actor_id", sa.String(80), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("business_key", sa.String(80), nullable=False),
        sa.Column("expected_revision", sa.Integer, nullable=False),
        sa.Column(
            "from_version_id",
            sa.String(80),
            sa.ForeignKey("billing_plan_versions.id"),
            nullable=False,
        ),
        sa.Column(
            "to_version_id",
            sa.String(80),
            sa.ForeignKey("billing_plan_versions.id"),
            nullable=False,
        ),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.String(300), nullable=False),
        sa.Column("booked_operation_id", sa.String(80), unique=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled_by", sa.String(80), sa.ForeignKey("users.id")),
        sa.Column("cancel_key", sa.String(80)),
        sa.Column("cancel_reason", sa.String(300)),
        sa.Column("cancel_revision", sa.Integer),
        sa.Column(
            "restores_change_id",
            sa.String(80),
            sa.ForeignKey("billing_subscription_changes.id"),
            unique=True,
        ),
        sa.UniqueConstraint("actor_id", "business_key"),
        sa.UniqueConstraint("cancelled_by", "cancel_key"),
        sa.ForeignKeyConstraint(
            ["user_id", "booked_operation_id"],
            ["billing_operations.user_id", "billing_operations.id"],
        ),
        sa.CheckConstraint("from_version_id <> to_version_id AND expected_revision > 0"),
        sa.CheckConstraint(
            "(cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_key IS NULL "
            "AND cancel_reason IS NULL AND cancel_revision IS NULL) OR "
            "(cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_key IS NOT NULL "
            "AND cancel_reason IS NOT NULL AND cancel_revision IS NOT NULL AND cancel_revision > 0)"
        ),
    )
    op.create_index(
        "uq_billing_change_pending",
        "billing_subscription_changes",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("booked_operation_id IS NULL AND cancelled_at IS NULL"),
    )
    op.create_index(
        "ix_billing_change_owner_time",
        "billing_subscription_changes",
        ["user_id", "created_at", "id"],
    )


def downgrade() -> None:
    raise RuntimeError("换档历史可能已关联办理单，请通过升级前备份恢复")

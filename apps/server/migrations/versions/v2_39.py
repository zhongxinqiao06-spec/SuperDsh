"""Registered management modules and versioned navigation configuration."""

import json

import sqlalchemy as sa
from alembic import op

from agent_server.core.navigation import default_menu_items
from agent_server.core.utc import utc_now
from agent_server.infra.db.identity_schema import roles
from agent_server.infra.db.navigation import navigation_settings

revision = "v2_39"
down_revision = "v2_38"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    navigation_settings.create(bind, checkfirst=True)
    if not bind.execute(sa.select(navigation_settings.c.id)).first():
        bind.execute(
            navigation_settings.insert().values(
                id="global",
                version=1,
                items_json=json.dumps(default_menu_items()),
                updated_at=utc_now(),
            )
        )
    row = (
        bind.execute(
            sa.select(roles).where(roles.c.id == "admin", roles.c.builtin == 1)
        )
        .mappings()
        .one()
    )
    permissions = sorted(
        set(json.loads(row["permissions_json"])) | {"menus.read", "menus.manage"}
    )
    bind.execute(
        roles.update()
        .where(roles.c.id == "admin")
        .values(
            permissions_json=json.dumps(permissions),
            updated_at=utc_now(),
        )
    )


def downgrade() -> None:
    raise RuntimeError(
        "navigation migration requires restoring a pre-upgrade backup to downgrade"
    )

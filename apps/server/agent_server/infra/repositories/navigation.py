"""Navigation persistence; identity, version and audit share one transaction."""

from __future__ import annotations

import json
import secrets

from sqlalchemy import insert, select, update

from agent_server.core.models import UserView
from agent_server.core.navigation import (
    assert_menu_edit_allowed,
    validate_menu_items,
)
from agent_server.core.utc import utc_now
from agent_server.infra.db.identity_schema import identity_audit, roles
from agent_server.infra.db.navigation import navigation_settings
from agent_server.infra.db.schema import users
from agent_server.infra.repositories.identity import identity_lock


class MenuVersionConflict(Exception):
    pass


class NavigationRepositoryMixin:
    async def navigation_configuration(self) -> dict:
        async with self._engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        select(navigation_settings).where(
                            navigation_settings.c.id == "global"
                        )
                    )
                )
                .mappings()
                .one()
            )
        return {"version": row["version"], "items": json.loads(row["items_json"])}

    async def save_navigation(
        self,
        *,
        version: int,
        items: list[dict],
        actor: UserView,
        reset: bool = False,
    ) -> dict:
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            # Check again after the identity lock: a concurrent permission change
            # must not authorize a write using the request's stale principal.
            user_row = (
                (await conn.execute(select(users).where(users.c.id == actor.userId)))
                .mappings()
                .first()
            )
            if not user_row:
                raise PermissionError("account unavailable")
            current_actor = await self._user_with_grants(conn, user_row)
            if (
                current_actor.disabled
                or current_actor.deletedAt
                or current_actor.resetRequired
                or current_actor.authzVersion != actor.authzVersion
                or "menus.manage" not in current_actor.permissions
            ):
                raise PermissionError("menu management permission required")
            previous = (
                (
                    await conn.execute(
                        select(navigation_settings).where(
                            navigation_settings.c.id == "global"
                        )
                    )
                )
                .mappings()
                .one()
            )
            if previous["version"] != version:
                raise MenuVersionConflict(
                    "menu configuration changed; reload before saving"
                )
            role_ids = set((await conn.execute(select(roles.c.id))).scalars())
            validate_menu_items(items, role_ids)
            old = json.loads(previous["items_json"])
            assert_menu_edit_allowed(old, items, current_actor.permissions)
            changed = await conn.execute(
                update(navigation_settings)
                .where(
                    navigation_settings.c.id == "global",
                    navigation_settings.c.version == version,
                )
                .values(
                    version=version + 1,
                    items_json=json.dumps(items),
                    updated_by=actor.userId,
                    updated_at=utc_now(),
                )
            )
            if changed.rowcount != 1:
                raise MenuVersionConflict(
                    "menu configuration changed; reload before saving"
                )
            await conn.execute(
                insert(identity_audit).values(
                    id=secrets.token_urlsafe(18),
                    actor_id=actor.userId,
                    action="menu.reset" if reset else "menu.updated",
                    target_id="global",
                    created_at=utc_now(),
                    detail_json=json.dumps(
                        {"previousVersion": version, "version": version + 1}
                    ),
                )
            )
        return {"version": version + 1, "items": items}

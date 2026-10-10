"""Identity operations: stable owners, explicit grants and revocable sessions."""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, insert, or_, select, text, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.core.auth import (
    create_user_access_token,
    hash_password,
    user_access_claims,
)
from agent_server.core.models import UserView
from agent_server.core.permissions import validate_permissions
from agent_server.core.utc import utc_now
from agent_server.infra.db.identity_schema import (
    auth_sessions,
    identity_audit,
    recovery_codes,
    roles,
    user_roles,
)
from agent_server.infra.db.schema import users
from agent_server.infra.repositories.store_support import _user_from_row


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


async def identity_lock(conn) -> None:
    if conn.dialect.name == "postgresql":
        await conn.execute(text("SELECT pg_advisory_xact_lock(4141455)"))
    elif conn.dialect.name == "sqlite":
        await conn.execute(text("BEGIN IMMEDIATE"))


class IdentityRepositoryMixin:
    async def assert_user_manageable(self, user_id: str, actor: UserView) -> None:
        target = await self.get_user(user_id)
        if not set(target.permissions).issubset(actor.permissions):
            raise ValueError("cannot manage an account above your authority")

    async def get_user(self, user_id: str) -> UserView:
        async with self._engine.connect() as conn:
            row = (
                (await conn.execute(select(users).where(users.c.id == user_id)))
                .mappings()
                .first()
            )
            if row is None:
                raise KeyError(user_id)
            return await self._user_with_grants(conn, row)

    async def _user_with_grants(
        self, conn: AsyncConnection, row: RowMapping
    ) -> UserView:
        grants = (
            (
                await conn.execute(
                    select(user_roles.c.role_id).where(
                        user_roles.c.user_id == row["id"]
                    )
                )
            )
            .scalars()
            .all()
        )
        # Legacy repository-created test/connector accounts retain their builtin role.
        role_ids = list(grants) or [row["role"]]
        permissions = (
            (
                await conn.execute(
                    select(roles.c.permissions_json).where(roles.c.id.in_(role_ids))
                )
            )
            .scalars()
            .all()
        )
        user = _user_from_row(row)
        user.roles = sorted(role_ids)
        user.permissions = sorted(
            {permission for raw in permissions for permission in json.loads(raw)}
        )
        user.role = "admin" if "admin" in role_ids else "member"
        return user

    async def list_users(self) -> list[UserView]:
        async with self._engine.connect() as conn:
            ids = (
                (await conn.execute(select(users.c.id).order_by(users.c.created_at)))
                .scalars()
                .all()
            )
        return [await self.get_user(value) for value in ids]

    async def effective_permissions(self, user: UserView) -> list[str]:
        return (await self.get_user(user.userId)).permissions

    async def authenticate_user_token(self, token: str) -> UserView | None:
        claims = user_access_claims(token)
        if not claims:
            return None
        try:
            user = await self.get_user(claims["sub"])
        except KeyError:
            return None
        if user.disabled or user.deletedAt:
            return None
        sid = claims.get("sid")
        if not sid:
            # Only explicitly injected isolated SQLite fixtures can use old test tokens.
            return user if getattr(self, "allow_legacy_test_tokens", False) else None
        if claims.get("ver") != user.authzVersion:
            return None
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(auth_sessions).where(
                        auth_sessions.c.id == sid,
                        auth_sessions.c.user_id == user.userId,
                        auth_sessions.c.revoked_at.is_(None),
                        auth_sessions.c.expires_at > utc_now(),
                        auth_sessions.c.auth_version == user.authzVersion,
                    )
                )
            ).first()
        return user if row else None

    async def issue_login(self, user_id: str, *, client_name: str = "Browser") -> dict:
        user = await self.get_user(user_id)
        if user.disabled or user.deletedAt:
            raise ValueError("account is unavailable")
        sid = "ses_" + secrets.token_urlsafe(24)
        refresh = sid + "." + secrets.token_urlsafe(48)
        now = utc_now()
        expiry = (
            (datetime.now(UTC) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
        )
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(auth_sessions).values(
                    id=sid,
                    user_id=user_id,
                    refresh_hash=token_hash(refresh),
                    auth_version=user.authzVersion,
                    client_name=client_name[:80],
                    created_at=now,
                    last_seen_at=now,
                    expires_at=expiry,
                )
            )
        return {
            "user": user,
            "accessToken": create_user_access_token(
                user_id, session_id=sid, auth_version=user.authzVersion
            ),
            "refreshToken": refresh,
            "sessionId": sid,
        }

    async def refresh_login(self, refresh: str) -> dict | None:
        sid = refresh.split(".", 1)[0]
        digest = token_hash(refresh)
        now = utc_now()
        rotated = sid + "." + secrets.token_urlsafe(48)
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        select(auth_sessions)
                        .where(auth_sessions.c.id == sid)
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row is None or row["revoked_at"] or row["expires_at"] <= now:
                return None
            if row["refresh_hash"] != digest:
                if row["previous_refresh_hash"] == digest:
                    await conn.execute(
                        update(auth_sessions)
                        .where(auth_sessions.c.id == sid)
                        .values(revoked_at=now)
                    )
                return None
            user_row = (
                (await conn.execute(select(users).where(users.c.id == row["user_id"])))
                .mappings()
                .first()
            )
            if (
                not user_row
                or user_row["disabled"]
                or user_row["deleted_at"]
                or user_row["auth_version"] != row["auth_version"]
            ):
                await conn.execute(
                    update(auth_sessions)
                    .where(auth_sessions.c.id == sid)
                    .values(revoked_at=now)
                )
                return None
            result = await conn.execute(
                update(auth_sessions)
                .where(
                    auth_sessions.c.id == sid,
                    auth_sessions.c.refresh_hash == digest,
                    auth_sessions.c.revoked_at.is_(None),
                )
                .values(
                    refresh_hash=token_hash(rotated),
                    previous_refresh_hash=digest,
                    last_seen_at=now,
                )
            )
            if result.rowcount != 1:
                return None
            user_id = row["user_id"]
            # Build the identity and access token before committing rotation.
            # A failed grant read must leave the caller's refresh token usable.
            user = await self._user_with_grants(conn, user_row)
            return {
                "user": user,
                "accessToken": create_user_access_token(
                    user_id, session_id=sid, auth_version=user.authzVersion
                ),
                "refreshToken": rotated,
                "sessionId": sid,
            }

    async def revoke_login(
        self,
        *,
        user_id: str | None = None,
        session_id: str | None = None,
        refresh: str | None = None,
    ) -> None:
        query = update(auth_sessions).where(auth_sessions.c.revoked_at.is_(None))
        if user_id:
            query = query.where(auth_sessions.c.user_id == user_id)
        if session_id:
            query = query.where(auth_sessions.c.id == session_id)
        if refresh:
            query = query.where(auth_sessions.c.refresh_hash == token_hash(refresh))
        if not any((user_id, session_id, refresh)):
            return
        async with self._engine.begin() as conn:
            await conn.execute(query.values(revoked_at=utc_now()))

    async def login_sessions(self, user_id: str, current_sid: str | None) -> list[dict]:
        async with self._engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        select(auth_sessions)
                        .where(
                            auth_sessions.c.user_id == user_id,
                            auth_sessions.c.revoked_at.is_(None),
                            auth_sessions.c.expires_at > utc_now(),
                        )
                        .order_by(auth_sessions.c.created_at.desc())
                    )
                )
                .mappings()
                .all()
            )
        return [
            {
                "id": row["id"],
                "clientName": row["client_name"],
                "createdAt": row["created_at"],
                "lastSeenAt": row["last_seen_at"],
                "expiresAt": row["expires_at"],
                "current": row["id"] == current_sid,
            }
            for row in rows
        ]

    async def update_user_password(
        self,
        user_id: str,
        password: str | None = None,
        *,
        password_hash: str | None = None,
    ) -> None:
        stored = password_hash or (hash_password(password) if password else None)
        if not stored:
            raise ValueError("password is required")
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(users)
                .where(users.c.id == user_id, users.c.deleted_at.is_(None))
                .values(
                    password_hash=stored,
                    auth_version=users.c.auth_version + 1,
                    reset_required=0,
                    updated_at=utc_now(),
                )
            )
            if not result.rowcount:
                raise KeyError(user_id)
            await conn.execute(
                update(auth_sessions)
                .where(auth_sessions.c.user_id == user_id)
                .values(revoked_at=utc_now())
            )
            await conn.execute(
                delete(recovery_codes).where(recovery_codes.c.user_id == user_id)
            )

    async def set_user_roles(
        self, user_id: str, role_ids: list[str], *, actor: UserView
    ) -> UserView:
        role_ids = sorted(set(role_ids))
        if not role_ids:
            raise ValueError("at least one role is required")
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            current = (
                (await conn.execute(select(users).where(users.c.id == user_id)))
                .mappings()
                .first()
            )
            if not current:
                raise KeyError(user_id)
            grants = (
                (await conn.execute(select(roles).where(roles.c.id.in_(role_ids))))
                .mappings()
                .all()
            )
            if len(grants) != len(role_ids):
                raise ValueError("role not found")
            requested = {
                p for role in grants for p in json.loads(role["permissions_json"])
            }
            if not requested.issubset(set(actor.permissions)):
                raise ValueError("cannot grant permissions you do not hold")
            if actor.userId == user_id:
                raise ValueError("cannot change your own roles")
            if current["role"] == "admin" and "admin" not in role_ids:
                await self._protect_last_admin(conn, user_id)
            await conn.execute(
                delete(user_roles).where(user_roles.c.user_id == user_id)
            )
            for role_id in role_ids:
                await conn.execute(
                    insert(user_roles).values(user_id=user_id, role_id=role_id)
                )
            await conn.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(
                    role="admin" if "admin" in role_ids else "member",
                    auth_version=users.c.auth_version + 1,
                    updated_at=utc_now(),
                )
            )
        return await self.get_user(user_id)

    async def update_user_admin(
        self,
        user_id: str,
        *,
        actor: UserView,
        display_name: str | None,
        role_ids: list[str] | None,
        disabled: bool | None,
    ) -> UserView:
        """Validate the complete change before writing any field."""
        from agent_server.infra.repositories.email_accounts import (
            normalize_display_name,
        )

        values = {"updated_at": utc_now()}
        if display_name is not None:
            values["display_name"] = normalize_display_name(display_name)
        if role_ids is not None:
            role_ids = sorted(set(role_ids))
            if not role_ids:
                raise ValueError("at least one role is required")
            if user_id == actor.userId:
                raise ValueError("cannot change your own roles")
            values["role"] = "admin" if "admin" in role_ids else "member"
        if disabled is not None:
            if user_id == actor.userId and disabled:
                raise ValueError("cannot disable yourself")
            values["disabled"] = int(disabled)
        if role_ids is not None or disabled is not None:
            values["auth_version"] = users.c.auth_version + 1
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            current = (
                (await conn.execute(select(users).where(users.c.id == user_id)))
                .mappings()
                .first()
            )
            if not current:
                raise KeyError(user_id)
            if current["deleted_at"] and disabled is False:
                raise ValueError("restore this account before enabling it")
            acting = (
                (await conn.execute(select(users).where(users.c.id == actor.userId)))
                .mappings()
                .first()
            )
            if (
                not acting
                or acting["disabled"]
                or acting["deleted_at"]
                or acting["auth_version"] != actor.authzVersion
            ):
                raise ValueError("acting account authorization changed")
            if role_ids is not None:
                grants = (
                    (await conn.execute(select(roles).where(roles.c.id.in_(role_ids))))
                    .mappings()
                    .all()
                )
                if len(grants) != len(role_ids):
                    raise ValueError("role not found")
                if not {
                    p for role in grants for p in json.loads(role["permissions_json"])
                }.issubset(actor.permissions):
                    raise ValueError("cannot grant permissions you do not hold")
            losing_admin = current["role"] == "admin" and (
                disabled is True or (role_ids is not None and "admin" not in role_ids)
            )
            if losing_admin and not current["disabled"] and not current["deleted_at"]:
                await self._protect_last_admin(conn, user_id)
            if role_ids is not None:
                await conn.execute(
                    delete(user_roles).where(user_roles.c.user_id == user_id)
                )
                for role_id in role_ids:
                    await conn.execute(
                        insert(user_roles).values(user_id=user_id, role_id=role_id)
                    )
            await conn.execute(
                update(users).where(users.c.id == user_id).values(**values)
            )
        return await self.get_user(user_id)

    async def _protect_last_admin(self, conn, user_id: str) -> None:
        other = (
            await conn.execute(
                select(users.c.id).where(
                    users.c.id != user_id,
                    users.c.role == "admin",
                    users.c.disabled == 0,
                    users.c.deleted_at.is_(None),
                )
            )
        ).first()
        if not other:
            raise ValueError("cannot remove the last active admin")

    async def set_user_disabled(self, user_id: str, disabled: bool) -> UserView:
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            row = (
                (await conn.execute(select(users).where(users.c.id == user_id)))
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(user_id)
            if (
                disabled
                and row["role"] == "admin"
                and not row["disabled"]
                and not row["deleted_at"]
            ):
                await self._protect_last_admin(conn, user_id)
            await conn.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(
                    disabled=int(disabled),
                    auth_version=users.c.auth_version + 1,
                    updated_at=utc_now(),
                )
            )
        return await self.get_user(user_id)

    async def soft_delete_user(self, user_id: str, *, actor_id: str) -> None:
        if user_id == actor_id:
            raise ValueError("cannot delete yourself")
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            row = (
                (await conn.execute(select(users).where(users.c.id == user_id)))
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(user_id)
            if row["role"] == "admin" and not row["disabled"] and not row["deleted_at"]:
                await self._protect_last_admin(conn, user_id)
            await conn.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(
                    disabled=1,
                    deleted_at=utc_now(),
                    deleted_by=actor_id,
                    auth_version=users.c.auth_version + 1,
                    updated_at=utc_now(),
                )
            )
            await conn.execute(
                update(auth_sessions)
                .where(auth_sessions.c.user_id == user_id)
                .values(revoked_at=utc_now())
            )

    async def restore_user(self, user_id: str) -> UserView:
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            row = (
                (await conn.execute(select(users).where(users.c.id == user_id)))
                .mappings()
                .first()
            )
            if row is None:
                raise KeyError(user_id)
            if row["deleted_at"] is None:
                raise ValueError("only deleted accounts can be restored")
            result = await conn.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(
                    deleted_at=None,
                    deleted_by=None,
                    disabled=1,
                    auth_version=users.c.auth_version + 1,
                    updated_at=utc_now(),
                )
            )
            if not result.rowcount:
                raise KeyError(user_id)
        return await self.get_user(user_id)

    async def role_catalog(self) -> list[dict]:
        async with self._engine.connect() as conn:
            rows = (
                (await conn.execute(select(roles).order_by(roles.c.id)))
                .mappings()
                .all()
            )
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "builtin": bool(row["builtin"]),
                "permissions": json.loads(row["permissions_json"]),
            }
            for row in rows
        ]

    async def save_role(
        self,
        role_id: str | None,
        *,
        name: str,
        description: str,
        permissions: list[str],
        actor: UserView,
    ) -> dict:
        permissions = validate_permissions(permissions)
        if role_id == "admin":
            raise ValueError("system administrator role is immutable")
        if not set(permissions).issubset(actor.permissions):
            raise ValueError("cannot grant permissions you do not hold")
        if not name.strip():
            raise ValueError("role name is required")
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            if role_id:
                old = (
                    (await conn.execute(select(roles).where(roles.c.id == role_id)))
                    .mappings()
                    .first()
                )
                if not old:
                    raise KeyError(role_id)
                if not set(json.loads(old["permissions_json"])).issubset(
                    actor.permissions
                ):
                    raise ValueError("cannot edit a role above your authority")
                await conn.execute(
                    update(roles)
                    .where(roles.c.id == role_id)
                    .values(
                        name=name.strip(),
                        description=description,
                        permissions_json=json.dumps(permissions),
                        updated_at=utc_now(),
                    )
                )
                affected = select(user_roles.c.user_id).where(
                    user_roles.c.role_id == role_id
                )
                await conn.execute(
                    update(users)
                    .where(or_(users.c.id.in_(affected), users.c.role == role_id))
                    .values(auth_version=users.c.auth_version + 1)
                )
            else:
                role_id = "role_" + secrets.token_urlsafe(12)
                await conn.execute(
                    insert(roles).values(
                        id=role_id,
                        name=name.strip(),
                        description=description,
                        builtin=0,
                        permissions_json=json.dumps(permissions),
                        updated_at=utc_now(),
                    )
                )
        return next(role for role in await self.role_catalog() if role["id"] == role_id)

    async def delete_role(self, role_id: str, *, actor: UserView) -> None:
        async with self._engine.begin() as conn:
            await identity_lock(conn)
            row = (
                (await conn.execute(select(roles).where(roles.c.id == role_id)))
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(role_id)
            if row["builtin"]:
                raise ValueError("builtin roles cannot be deleted")
            if not set(json.loads(row["permissions_json"])).issubset(actor.permissions):
                raise ValueError("cannot delete a role above your authority")
            if (
                await conn.execute(
                    select(user_roles.c.user_id).where(user_roles.c.role_id == role_id)
                )
            ).first():
                raise ValueError("remove role assignments before deleting this role")
            await conn.execute(delete(roles).where(roles.c.id == role_id))

    async def generate_recovery_codes(self, user_id: str) -> list[str]:
        codes = [secrets.token_hex(16) for _ in range(8)]
        async with self._engine.begin() as conn:
            await conn.execute(
                delete(recovery_codes).where(recovery_codes.c.user_id == user_id)
            )
            for code in codes:
                await conn.execute(
                    insert(recovery_codes).values(
                        user_id=user_id,
                        code_hash=token_hash(code),
                        created_at=utc_now(),
                    )
                )
        return codes

    async def reset_with_recovery(self, user_id: str, code: str, password: str) -> bool:
        if not password:
            raise ValueError("password is required")
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(recovery_codes)
                .where(
                    recovery_codes.c.user_id == user_id,
                    recovery_codes.c.code_hash == token_hash(code),
                    recovery_codes.c.consumed_at.is_(None),
                )
                .values(consumed_at=utc_now())
            )
            if result.rowcount != 1:
                return False
            result = await conn.execute(
                update(users)
                .where(
                    users.c.id == user_id,
                    users.c.deleted_at.is_(None),
                    users.c.disabled == 0,
                )
                .values(
                    password_hash=hash_password(password),
                    auth_version=users.c.auth_version + 1,
                    reset_required=0,
                    updated_at=utc_now(),
                )
            )
            if result.rowcount != 1:
                raise ValueError("account unavailable")
            await conn.execute(
                update(auth_sessions)
                .where(auth_sessions.c.user_id == user_id)
                .values(revoked_at=utc_now())
            )
        return True

    async def request_password_reset(self, user_id: str) -> None:
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(users)
                .where(users.c.id == user_id, users.c.deleted_at.is_(None))
                .values(
                    reset_required=1,
                    auth_version=users.c.auth_version + 1,
                    updated_at=utc_now(),
                )
            )
            if not result.rowcount:
                raise KeyError(user_id)

    async def reset_with_email_code(self, email: str, code: str, password: str) -> bool:
        from agent_server.infra.repositories.email_accounts import normalize_email

        email = normalize_email(email)
        async with self._engine.begin() as conn:
            user = (
                (
                    await conn.execute(
                        select(users).where(
                            users.c.email == email,
                            users.c.disabled == 0,
                            users.c.deleted_at.is_(None),
                            users.c.email_verified_at.is_not(None),
                        )
                    )
                )
                .mappings()
                .first()
            )
            if not user:
                return False
            valid = await self._consume_email_code(
                conn, email=email, purpose="reset", user_id=user["id"], code=code
            )
            if not valid:
                return False
            await conn.execute(
                update(users)
                .where(users.c.id == user["id"])
                .values(
                    password_hash=hash_password(password),
                    auth_version=users.c.auth_version + 1,
                    reset_required=0,
                    updated_at=utc_now(),
                )
            )
            await conn.execute(
                update(auth_sessions)
                .where(auth_sessions.c.user_id == user["id"])
                .values(revoked_at=utc_now())
            )
            await conn.execute(
                delete(recovery_codes).where(recovery_codes.c.user_id == user["id"])
            )
        return True

    async def record_audit(
        self, actor_id: str, action: str, target_id: str, detail: dict | None = None
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(identity_audit).values(
                    id=secrets.token_urlsafe(18),
                    actor_id=actor_id,
                    action=action,
                    target_id=target_id,
                    detail_json=json.dumps(detail or {}),
                    created_at=utc_now(),
                )
            )

    async def list_audit(self) -> list[dict]:
        async with self._engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        select(identity_audit)
                        .order_by(identity_audit.c.created_at.desc())
                        .limit(200)
                    )
                )
                .mappings()
                .all()
            )
        return [
            {
                "id": row["id"],
                "actorId": row["actor_id"],
                "action": row["action"],
                "targetId": row["target_id"],
                "createdAt": row["created_at"],
                "detail": json.loads(row["detail_json"]),
            }
            for row in rows
        ]

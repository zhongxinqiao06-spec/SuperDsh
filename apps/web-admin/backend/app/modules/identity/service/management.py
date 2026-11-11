"""账号与角色管理用例；管理权限不能授予自己没有的权限。"""

from datetime import UTC, datetime
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import PERMISSIONS, Account, Role, User
from app.modules.identity.entity.bo.validation import account_username, collision_username
from app.modules.identity.entity.bo.validation import display_name as validated_display_name
from app.modules.identity.service.ports import (
    IdentityRepository,
    IdentitySecurity,
    IdentityTransaction,
)

from .identity import resolve_account


async def current_actor(tx: IdentityTransaction, actor: Account, permission: str) -> Account:
    """写事务内重新读取授权，防止请求鉴权之后发生撤权。"""
    user = await tx.user(actor.user_id)
    if not user or user.auth_version != actor.auth_version:
        raise DomainError(401, "login session expired or revoked")
    current = await resolve_account(tx, user, actor.session_id)
    current.require(permission)
    return current


def within_permissions(grants: list[str] | tuple[str, ...], actor: Account) -> None:
    """对目标账号和角色同样检查权限上限，禁止借管理入口提权。"""
    if not set(grants).issubset(actor.permissions):
        raise DomainError(403, "cannot grant or manage permissions you do not hold")


async def validate_roles(tx: IdentityTransaction, actor: Account, ids: list[str]) -> None:
    roles = {role.id: role for role in await tx.roles()}
    if not ids or len(set(ids)) != len(ids) or any(role not in roles for role in ids):
        raise DomainError(422, "invalid roles")
    for role in ids:
        within_permissions(roles[role].permissions, actor)


class AccountManagement:
    """后台基础账号/角色能力，不提供他人文件和会话读取捷径。"""

    def __init__(self, repository: IdentityRepository, security: IdentitySecurity) -> None:
        self.repository, self.security = repository, security

    async def list_users(
        self, actor: Account, page: int, page_size: int, search: str
    ) -> tuple[list[Account], int]:
        actor.require("users.read")
        async with self.repository.transaction() as tx:
            users = [
                user
                for user in await tx.users()
                if search.strip().lower()
                in f"{user.username} {user.email or ''} {user.display_name or ''}".lower()
            ]
            return [
                await resolve_account(tx, user)
                for user in users[(page - 1) * page_size : page * page_size]
            ], len(users)

    async def create_user(
        self,
        actor: Account,
        username: str,
        password: str | None,
        verifier: str | None,
        salt: str | None,
        roles: list[str],
        display_name: str | None,
        email: str | None,
    ) -> Account:
        actor.require("users.manage")
        explicit_username = bool(username)
        username = account_username(username, email)
        display_name = validated_display_name(display_name)
        hashed = await self.security.hash_password(password, verifier, salt)
        async with self.repository.transaction() as tx:
            await tx.lock()
            actor = await current_actor(tx, actor, "users.manage")
            if roles != ["member"]:
                actor.require("roles.manage")
            await validate_roles(tx, actor, roles)
            if not explicit_username and email and await tx.find_user(username):
                username = collision_username(username, email)
            if await tx.find_user(username) or (email and await tx.find_user(email)):
                raise DomainError(409, "account already exists")
            user = User(
                str(uuid4()),
                username,
                hashed,
                roles,
                email,
                display_name,
                reset_required=True,
                created_at=datetime.now(UTC),
            )
            await tx.save_user(user)
            await tx.audit(actor.user_id, "user.created", user.id, {"roles": roles})
            return await resolve_account(tx, user)

    async def update_user(
        self, actor: Account, user_id: str, patch: dict[str, object], operation: str = "edit"
    ) -> Account:
        """串行保护最后管理员；revision 冲突不会覆盖用户未保存的编辑。"""
        async with self.repository.transaction() as tx:
            await tx.lock()
            actor = await current_actor(tx, actor, "users.manage")
            user = await tx.user(user_id)
            if not user:
                raise DomainError(404, "user not found")
            target = await resolve_account(tx, user)
            within_permissions(target.permissions, actor)
            if patch.get("revision", user.revision) != user.revision:
                raise DomainError(
                    409, "user was changed; reload before saving", "revision_conflict"
                )
            if any(key in patch for key in ("password", "passwordVerifier", "passwordSalt")):
                raise DomainError(
                    409,
                    "administrators cannot set another account's password; request recovery instead",
                )
            roles = patch.get("roles", user.roles)
            if not isinstance(roles, list) or not all(isinstance(role, str) for role in roles):
                raise DomainError(422, "invalid roles")
            if "roles" in patch:
                actor.require("roles.manage")
                if user_id == actor.user_id:
                    raise DomainError(409, "cannot change your own roles")
                await validate_roles(tx, actor, roles)
            if user_id == actor.user_id and (
                operation == "delete" or patch.get("disabled") is True
            ):
                raise DomainError(409, "cannot disable or delete yourself")
            removing = (
                operation == "delete" or patch.get("disabled") is True or "admin" not in roles
            )
            if removing and "admin" in user.roles and not user.disabled and not user.deleted_at:
                others = [
                    other
                    for other in await tx.users()
                    if other.id != user.id
                    and "admin" in other.roles
                    and not other.disabled
                    and not other.deleted_at
                ]
                if not others:
                    raise DomainError(409, "cannot remove the last active admin")
            if operation == "restore":
                if user.deleted_at is None:
                    raise DomainError(409, "only deleted accounts can be restored")
                user.deleted_at = None
            elif operation == "delete":
                user.deleted_at = datetime.now(UTC)
            elif operation == "reset":
                user.reset_required = True
            elif user.deleted_at and patch.get("disabled") is False:
                raise DomainError(409, "restore this account before enabling it")
            if "displayName" in patch:
                user.display_name = validated_display_name(patch["displayName"])
            if "disabled" in patch:
                if not isinstance(patch["disabled"], bool):
                    raise DomainError(422, "disabled must be a boolean")
                user.disabled = patch["disabled"]
            user.roles = roles
            if any(key in patch for key in ("disabled", "roles")) or operation != "edit":
                user.auth_version += 1
            user.revision += 1
            await tx.save_user(user)
            await tx.audit(actor.user_id, f"user.{operation}", user.id, {"fields": list(patch)})
            return await resolve_account(tx, user)

    async def list_roles(self, actor: Account) -> list[Role]:
        actor.require("roles.manage")
        async with self.repository.transaction() as tx:
            return await tx.roles()

    async def save_role(
        self,
        actor: Account,
        role_id: str | None,
        name: str,
        description: str,
        permissions: list[str],
        revision: int | None,
    ) -> Role:
        """授权变更使所有引用账号的既有令牌失效。"""
        name = name.strip()
        permissions = sorted(set(permissions))
        if not name or len(name) > 64 or len(description) > 500:
            raise DomainError(422, "invalid role or unknown permission")
        if not set(permissions).issubset(PERMISSIONS):
            raise DomainError(422, "unknown permission")
        async with self.repository.transaction() as tx:
            await tx.lock()
            actor = await current_actor(tx, actor, "roles.manage")
            within_permissions(permissions, actor)
            existing = next((item for item in await tx.roles() if item.id == role_id), None)
            if role_id and not existing:
                raise DomainError(404, "role not found")
            if existing and existing.builtin:
                raise DomainError(409, "builtin role cannot be modified")
            if existing and revision is not None and existing.revision != revision:
                raise DomainError(
                    409, "role was changed; reload before saving", "revision_conflict"
                )
            if existing:
                within_permissions(existing.permissions, actor)
            role = Role(
                role_id or str(uuid4()),
                name,
                description,
                sorted(set(permissions)),
                False,
                existing.revision + 1 if existing else 1,
            )
            await tx.save_role(role)
            for user in await tx.users():
                if role.id in user.roles:
                    user.auth_version += 1
                    await tx.save_user(user)
            await tx.audit(actor.user_id, "role.saved", role.id, {"permissions": role.permissions})
            return role

    async def delete_role(self, actor: Account, role_id: str) -> None:
        async with self.repository.transaction() as tx:
            await tx.lock()
            actor = await current_actor(tx, actor, "roles.manage")
            role = next((item for item in await tx.roles() if item.id == role_id), None)
            if not role:
                raise DomainError(404, "role not found")
            within_permissions(role.permissions, actor)
            if role.builtin or any(role_id in user.roles for user in await tx.users()):
                raise DomainError(409, "role is builtin or assigned")
            await tx.delete_role(role_id)
            await tx.audit(actor.user_id, "role.deleted", role_id, {})

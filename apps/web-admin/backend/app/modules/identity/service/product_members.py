"""按产品增减普通成员资格，保留同一账号的其他角色、作品与登录身份。"""

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account, User
from app.modules.identity.entity.bo.product_roles import MEMBER_ROLE, Product, product_grant
from app.modules.identity.entity.bo.validation import login_identifier
from app.modules.identity.entity.vo.product_members import ProductMember
from app.modules.identity.service.identity import current_actor
from app.modules.identity.service.ports import IdentityRepository, IdentityTransaction


class ProductMemberships:
    """只更新本产品的内置使用者角色，管理授权与审计和角色修改共用事务锁。"""

    def __init__(self, repository: IdentityRepository) -> None:
        self.repository = repository

    @staticmethod
    async def _product_roles(tx: IdentityTransaction, product: Product) -> set[str]:
        return {r.id for r in await tx.roles() if f"products.{product}" in r.permissions}

    @staticmethod
    def _row(user: User, actor: Account, product: Product, role_ids: set[str]) -> ProductMember:
        roles = [r for r in user.roles if r in role_ids]
        return ProductMember(
            userId=user.id,
            username=user.username,
            displayName=user.display_name,
            roleIds=roles,
            removable=user.id != actor.user_id and roles == [MEMBER_ROLE[product]],
            revision=user.revision,
        )

    async def list(
        self, actor: Account, product: Product, page: int, size: int, search: str
    ) -> tuple[list[ProductMember], int]:
        actor.require_product_management(product, "members")
        async with self.repository.transaction() as tx:
            role_ids = await self._product_roles(tx, product)
            rows, total = await tx.product_members(
                sorted(role_ids), search.strip(), (page - 1) * size, size
            )
            return [self._row(row, actor, product, role_ids) for row in rows], total

    async def grant(self, actor: Account, product: Product, identifier: str) -> ProductMember:
        actor.require_product_management(product, "members")
        name = login_identifier(identifier)
        async with self.repository.transaction() as tx:
            await tx.lock()
            actor = await current_actor(tx, actor, product_grant(product, "members"))
            actor.require_product_management(product, "members")
            user = await tx.find_user(name)
            if not user or user.deleted_at or user.disabled:
                raise DomainError(404, "找不到可加入的账号，请核对用户名或邮箱")
            role_ids = await self._product_roles(tx, product)
            if not role_ids.intersection(user.roles):
                user.roles = [*user.roles, MEMBER_ROLE[product]]
                await self._record(tx, actor, user, product, "granted")
            return self._row(user, actor, product, role_ids)

    async def revoke(self, actor: Account, product: Product, user_id: str, revision: int) -> None:
        actor.require_product_management(product, "members")
        async with self.repository.transaction() as tx:
            await tx.lock()
            actor = await current_actor(tx, actor, product_grant(product, "members"))
            actor.require_product_management(product, "members")
            user = await tx.user(user_id)
            role_ids = await self._product_roles(tx, product)
            if not user or user.deleted_at or not role_ids.intersection(user.roles):
                raise DomainError(404, "此账号不在当前产品成员列表中")
            if not self._row(user, actor, product, role_ids)["removable"]:
                raise DomainError(403, "该成员的产品权限由其他角色授予，不能在此移除")
            if user.revision != revision:
                raise DomainError(409, "成员已变更，请刷新列表", "revision_conflict")
            user.roles = [r for r in user.roles if r != MEMBER_ROLE[product]]
            await self._record(tx, actor, user, product, "revoked")

    @staticmethod
    async def _record(
        tx: IdentityTransaction, actor: Account, user: User, product: Product, action: str
    ) -> None:
        """一并更新权限代际，使已签发的接口和刷新凭据在资格变化后失效。"""
        user.auth_version += 1
        user.revision += 1
        await tx.save_user(user)
        await tx.audit(
            actor.user_id,
            "product.member." + action,
            user.id,
            {"product": product, "role": MEMBER_ROLE[product]},
        )

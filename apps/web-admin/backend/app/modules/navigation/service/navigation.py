"""产品菜单配置、权限过滤和显式恢复默认。"""

from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.navigation.entity.bo.navigation import MenuCatalog, Navigation, Product
from app.modules.navigation.service.menu_access import (
    editable_ids,
    merge_product_changes,
    require_menu_access,
)
from app.modules.navigation.service.ports import NavigationRepository
from app.modules.navigation.service.rules import filter_items, validate_items
from app.modules.navigation.service.upgrade import upgrade_items


class NavigationService:
    """默认目录由装配注入静态资源，运行时不读取旧包。"""

    def __init__(
        self,
        repository: NavigationRepository,
        catalogs: dict[Product, MenuCatalog],
        icons: list[str],
        role_choices: Callable[[Account, Product], Awaitable[list[dict[str, str]]]],
        product_roles: Callable[[Account, Product], Awaitable[tuple[str, ...]]],
        baseline: dict[str, Any] | None = None,
    ) -> None:
        self.repository, self.catalogs, self.icons = repository, catalogs, icons
        self.role_choices = role_choices
        self.product_roles = product_roles
        self.baseline = baseline

    async def initialize(self) -> None:
        """仅初始化缺失的产品配置，升级保留原办公行及管理员的自定义。"""
        for product, catalog in self.catalogs.items():
            async with self.repository.transaction(product) as tx:
                await tx.lock()
                previous = await tx.read()
                if previous is None:
                    await tx.save(Navigation(1, catalog.defaults), None)
                elif self.baseline:
                    items = upgrade_items(previous.items, product, catalog, self.baseline)
                    if items != previous.items:
                        validate_items(items, catalog.modules)
                        await tx.save(Navigation(previous.version + 1, items), None)

    async def catalog(
        self, account: Account, admin: bool = False, product: Product | None = None
    ) -> dict[str, object]:
        """管理目录与个人可见目录同源，权限隐藏不影响服务端检查。"""
        selected: Product = product or "office"
        global_access = False
        if admin:
            global_access = require_menu_access(account, selected)
            if "menus.manage" not in account.permissions and account.can_manage_product(
                selected, "menus"
            ):
                # 同时具有平台只读和产品编辑权时，表单提交的仍是该产品可写的子集。
                global_access = False
        elif product is not None:
            account.require("products." + product)
        catalog = self.catalogs[selected]
        async with self.repository.transaction(selected) as tx:
            value = await tx.read()
        if value is None:
            raise DomainError(503, "navigation is not initialized")
        items = value.items
        if not admin:
            # 未传产品的旧客户端可进入公共管理，但不能看到未授权的办公工作台。
            if product is None and "products.office" not in account.permissions:
                shared = {module["id"] for module in self.catalogs["entertainment"].modules}
                items = [i for i in items if i["kind"] == "group" or i["moduleId"] in shared]
            viewer = account
            if product is not None and any(i.get("roleIds") for i in items):
                # 从当前产品的真实角色计算限定菜单，另一端的会员身份不能命中此处的角色条件。
                viewer = replace(account, roles=await self.product_roles(account, product))
            items = filter_items(items, catalog.modules, viewer, all_menus="admin" in account.roles)
        if admin and not global_access:
            editable = editable_ids(items, catalog, account)
            parents = {i["parentId"] for i in items if i["id"] in editable}
            items = [i for i in items if i["id"] in editable or i["id"] in parents]
        return {
            "version": value.version,
            "items": items,
            **({"editableIds": sorted(editable)} if admin and not global_access else {}),
            "modules": catalog.modules
            if not admin or global_access
            else [m for m in catalog.modules if any(i["moduleId"] == m["id"] for i in items)],
            # 仅作为编辑器的图标建议，不限制管理员保存其他名称。
            "icons": self.icons,
        }

    async def save(
        self,
        account: Account,
        expected: int,
        items: list[dict[str, object]] | None,
        product: Product = "office",
    ) -> Navigation:
        """明确 reset 才恢复默认，编辑总是校验完整菜单图。"""
        global_access = require_menu_access(account, product, write=True)
        catalog = self.catalogs[product]
        roles = {role["id"] for role in await self.role_choices(account, product)}
        async with self.repository.transaction(product) as tx:
            await tx.lock()
            previous = await tx.read()
            if previous is None or previous.version != expected:
                raise DomainError(
                    409, "navigation was changed; reload before saving", "revision_conflict"
                )
            value = (
                (catalog.defaults if items is None else items)
                if global_access
                else merge_product_changes(previous.items, items, catalog, account)
            )
            validate_items(value, catalog.modules)
            old = {str(item["id"]): item for item in previous.items}
            new = {str(item["id"]): item for item in value}
            for key, node in new.items():
                assigned = node["roleIds"]
                if (
                    isinstance(assigned, list)
                    and (old.get(key) or {}).get("roleIds") != assigned
                    and not set(assigned).issubset(roles)
                ):
                    raise DomainError(422, "invalid menu roles")
            changed = {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)}
            grants = {str(module["id"]): module["permissions"] for module in catalog.modules}
            for item in [*previous.items, *value]:
                permissions = grants.get(str(item.get("moduleId")), [])
                if (
                    item["kind"] == "page"
                    and (item["id"] in changed or item.get("parentId") in changed)
                    and isinstance(permissions, list)
                    and permissions
                    # 菜单管理员可编排产品入口。业务模块仍须具备对应管理权。
                    and permissions != ["products." + product]
                    and not set(permissions).intersection(account.permissions)
                ):
                    raise DomainError(403, "cannot configure a page above your authority")
            result = Navigation(previous.version + 1, value)
            await tx.save(result, account.user_id)
            return result

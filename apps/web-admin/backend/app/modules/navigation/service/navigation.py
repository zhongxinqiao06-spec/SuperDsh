"""产品菜单配置、权限过滤和显式恢复默认。"""

from collections.abc import Awaitable, Callable

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.navigation.entity.bo.navigation import Navigation
from app.modules.navigation.service.ports import NavigationRepository
from app.modules.navigation.service.rules import filter_items, validate_items


class NavigationService:
    """默认目录由装配注入静态资源，运行时不读取旧包。"""

    def __init__(
        self,
        repository: NavigationRepository,
        modules: list[dict[str, object]],
        icons: list[str],
        defaults: list[dict[str, object]],
        role_choices: Callable[[Account], Awaitable[list[dict[str, str]]]],
    ) -> None:
        self.repository, self.modules, self.icons, self.defaults = (
            repository,
            modules,
            icons,
            defaults,
        )
        self.role_choices = role_choices

    async def initialize(self) -> None:
        """仅空配置初始化，重复启动不重置用户自定义菜单。"""
        async with self.repository.transaction() as tx:
            await tx.lock()
            if await tx.read() is None:
                await tx.save(Navigation(1, self.defaults), None)

    async def catalog(self, account: Account, admin: bool = False) -> dict[str, object]:
        """管理目录与个人可见目录同源，权限隐藏不影响服务端检查。"""
        if admin:
            account.require("menus.read" if "menus.read" in account.permissions else "menus.manage")
        async with self.repository.transaction() as tx:
            value = await tx.read()
        if value is None:
            raise DomainError(503, "navigation is not initialized")
        return {
            "version": value.version,
            "items": value.items if admin else filter_items(value.items, self.modules, account),
            "modules": self.modules,
            "icons": self.icons,
        }

    async def save(
        self, account: Account, expected: int, items: list[dict[str, object]] | None
    ) -> Navigation:
        """明确 reset 才恢复默认，编辑总是校验完整菜单图。"""
        account.require("menus.manage")
        value = self.defaults if items is None else items
        validate_items(value, self.modules, self.icons)
        roles = {role["id"] for role in await self.role_choices(account)}
        for item in value:
            selected = item.get("roleIds", [])
            if (
                not isinstance(selected, list)
                or len(selected) > 100
                or len(set(selected)) != len(selected)
                or not set(selected).issubset(roles)
            ):
                raise DomainError(422, "invalid menu roles")
        async with self.repository.transaction() as tx:
            await tx.lock()
            previous = await tx.read()
            if previous is None or previous.version != expected:
                raise DomainError(
                    409, "navigation was changed; reload before saving", "revision_conflict"
                )
            old = {str(item["id"]): item for item in previous.items}
            new = {str(item["id"]): item for item in value}
            changed = {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)}
            grants = {str(module["id"]): module["permissions"] for module in self.modules}
            for item in [*previous.items, *value]:
                permissions = grants.get(str(item.get("moduleId")), [])
                if (
                    item["kind"] == "page"
                    and (item["id"] in changed or item.get("parentId") in changed)
                    and isinstance(permissions, list)
                    and permissions
                    and not set(permissions).intersection(account.permissions)
                ):
                    raise DomainError(403, "cannot configure a page above your authority")
            result = Navigation(previous.version + 1, value)
            await tx.save(result, account.user_id)
            return result

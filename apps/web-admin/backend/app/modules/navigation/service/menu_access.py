"""产品管理员只能编排获授权的业务菜单，平台模块及其上级分组由服务端保护。"""

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.navigation.entity.bo.navigation import MenuCatalog, Product


def require_menu_access(account: Account, product: Product, *, write: bool = False) -> bool:
    """返回是否使用全局编排权限；显式的既有全局授权继续有效。"""
    for grant in ("menus.manage",) if write else ("menus.manage", "menus.read"):
        if grant in account.permissions:
            account.require(grant)
            return True
    account.require_product_management(product, "menus")
    return False


def editable_ids(
    items: list[dict[str, object]], catalog: MenuCatalog, account: Account
) -> set[str]:
    # 账号与账务共享两个产品的业务数据；换导航父级不改变平台菜单编排权。
    platform = {i["id"] for i in catalog.defaults if i["parentId"] == "platform"} | {
        "access.users",
        "billing.subscriptions",
        "billing.plans",
        "billing.rates",
    }
    grants = {m["id"]: m["permissions"] for m in catalog.modules}
    locked = {"platform"}
    for item in items:
        permissions = grants.get(item["id"], [])
        if item["kind"] == "page" and (
            item["id"] in platform
            or item["id"] in {"access.roles", "models.multimodal", "system.service"}
            or (
                isinstance(permissions, list)
                and permissions
                and not set(permissions).intersection(account.permissions)
            )
        ):
            locked.add(str(item["id"]))
            if item["parentId"]:
                locked.add(str(item["parentId"]))
    return {str(i["id"]) for i in items} - locked


def merge_product_changes(
    previous: list[dict[str, object]],
    draft: list[dict[str, object]] | None,
    catalog: MenuCatalog,
    account: Account,
) -> list[dict[str, object]]:
    editable = editable_ids(previous, catalog, account)
    protected = [i for i in previous if i["id"] not in editable]
    reserved = {str(i["id"]) for i in protected}
    candidates = (
        draft if draft is not None else [i for i in catalog.defaults if i["id"] not in reserved]
    )
    previous_by_id = {i["id"]: i for i in previous}
    visible_parents = {i["parentId"] for i in previous if i["id"] in editable}
    accepted = []
    for item in candidates:
        identifier, parent = item.get("id"), item.get("parentId")
        if not isinstance(identifier, str) or (parent is not None and not isinstance(parent, str)):
            raise DomainError(422, "invalid menu identifier or parent")
        previous_parent = previous_by_id.get(identifier, {}).get("parentId")
        # 混合分组在编辑器中作为只读父级显示，全表提交时保留数据库原件。
        if (
            identifier in reserved
            and identifier in visible_parents
            and item == previous_by_id[identifier]
        ):
            continue
        if (
            identifier in reserved
            or (
                draft is not None
                and parent in reserved
                and parent != previous_parent
                and parent != "product-management"
            )
            or (item.get("kind") == "page" and identifier not in editable)
        ):
            raise DomainError(403, "cannot configure a protected menu")
        accepted.append(item)
    return [*protected, *accepted]

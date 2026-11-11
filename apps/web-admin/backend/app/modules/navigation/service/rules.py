"""菜单图校验及过滤，避免界面配置变成授权通道。"""

import re

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account


def validate_items(
    items: list[dict[str, object]], modules: list[dict[str, object]], icons: list[str]
) -> None:
    """拒绝循环、重复页面、非法模块及不可识别字段。"""
    if len(items) > 128:
        raise DomainError(422, "too many menu items")
    ids: set[str] = set()
    pages: set[str] = set()
    known = {str(module["id"]) for module in modules}
    allowed = {"id", "kind", "moduleId", "parentId", "title", "icon", "order", "visible", "roleIds"}
    for item in items:
        identifier = item.get("id")
        if (
            not isinstance(identifier, str)
            or not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", identifier)
            or identifier in ids
            or not set(item).issubset(allowed)
        ):
            raise DomainError(422, "invalid or duplicate menu id")
        ids.add(identifier)
        if (
            item.get("kind") not in {"group", "page"}
            or item.get("icon") not in icons
            or not isinstance(item.get("visible"), bool)
            or type(item.get("order")) is not int
            or not 0 <= int(str(item["order"])) <= 10000
            or "moduleId" not in item
            or "parentId" not in item
        ):
            raise DomainError(422, "invalid menu properties")
        title = item.get("title")
        if not isinstance(title, str) or not 1 <= len(title) <= 64 or title != title.strip():
            raise DomainError(422, "invalid menu title")
        roles = item.get("roleIds")
        if (
            not isinstance(roles, list)
            or len(roles) > 100
            or any(not isinstance(role, str) for role in roles)
            or len(set(roles)) != len(roles)
        ):
            raise DomainError(422, "invalid menu roles")
        if item["kind"] == "page":
            module = str(item.get("moduleId", ""))
            if module not in known or module in pages or identifier != module:
                raise DomainError(422, "invalid or duplicate module")
            pages.add(module)
        elif (
            item.get("moduleId") is not None
            or item.get("parentId") is not None
            or identifier in known
        ):
            raise DomainError(422, "groups must be root nodes without a module")
    if pages != known:
        raise DomainError(422, "registered pages cannot be added or removed")
    by_id = {str(item["id"]): item for item in items}
    for item in items:
        visited = {str(item["id"])}
        parent = item.get("parentId")
        while parent is not None:
            if (
                not isinstance(parent, str)
                or parent not in by_id
                or parent in visited
                or by_id[parent]["kind"] != "group"
            ):
                raise DomainError(422, "invalid menu parent or cycle")
            visited.add(parent)
            parent = by_id[parent].get("parentId")


def filter_items(
    items: list[dict[str, object]], modules: list[dict[str, object]], account: Account
) -> list[dict[str, object]]:
    """沿祖先链应用可见性，再按模块权限过滤；不是后端授权替代品。"""
    by_id = {str(item["id"]): item for item in items}
    grants = {str(module["id"]): module["permissions"] for module in modules}
    visible: list[dict[str, object]] = []
    for item in items:
        current: dict[str, object] | None = item
        allowed = True
        while current:
            roles = current.get("roleIds")
            if not current.get("visible") or (
                isinstance(roles, list) and roles and not set(roles).intersection(account.roles)
            ):
                allowed = False
            current = by_id.get(str(current["parentId"])) if current.get("parentId") else None
        permissions = grants.get(str(item.get("moduleId")), [])
        if allowed and (
            item["kind"] == "group"
            or (
                isinstance(permissions, list)
                and (not permissions or bool(set(permissions).intersection(account.permissions)))
                and (not permissions or not account.reset_required)
            )
        ):
            visible.append(dict(item))
    parents = {item.get("parentId") for item in visible}
    return sorted(
        [item for item in visible if item["kind"] == "page" or item["id"] in parents],
        key=lambda item: (
            str(item.get("parentId") or ""),
            int(str(item["order"])),
            str(item["id"]),
        ),
    )

"""Product-owned pages; navigation configuration never grants permissions."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ICONS = (
    "gauge",
    "users",
    "shield",
    "menu",
    "bot",
    "key",
    "monitor",
    "settings",
    "user",
    "history",
    "paintbrush",
    "smartphone",
    "folder",
)


class NavigationModule(BaseModel):
    id: str
    route: str
    title: str
    icon: str
    permissions: list[str]


MODULES = tuple(
    NavigationModule(
        id=key, route=route, title=title, icon=icon, permissions=list(grants)
    )
    for key, route, title, icon, grants in (
        ("overview", "#/overview", "总览", "gauge", ()),
        ("access.users", "#/access/users", "用户管理", "users", ("users.read",)),
        ("access.roles", "#/access/roles", "角色与权限", "shield", ("roles.manage",)),
        (
            "access.menus",
            "#/access/menus",
            "菜单管理",
            "menu",
            ("menus.read", "menus.manage"),
        ),
        ("models", "#/models", "模型管理", "key", ("models.manage",)),
        (
            "devices",
            "#/operations/devices",
            "设备运维",
            "monitor",
            ("devices.inventory.read",),
        ),
        (
            "workbench",
            "#/workspace",
            "Agent 工作台",
            "bot",
            ("sessions.read", "sessions.run", "devices.read"),
        ),
        (
            "system.service",
            "#/system/service",
            "服务设置",
            "settings",
            ("settings.manage",),
        ),
        ("system.audit", "#/system/audit", "审计", "history", ("audit.read",)),
        ("account.profile", "#/account/profile", "账号资料", "user", ()),
        ("account.security", "#/account/security", "账号安全与登录记录", "shield", ()),
        (
            "account.models",
            "#/account/models",
            "个人模型",
            "key",
            ("models.personal.manage",),
        ),
        ("account.appearance", "#/account/appearance", "外观设置", "paintbrush", ()),
        ("account.mobile", "#/account/mobile", "手机登录记录", "smartphone", ()),
    )
)
MODULE_BY_ID = {module.id: module for module in MODULES}


class MenuNode(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")
    kind: Literal["group", "page"]
    moduleId: str | None
    parentId: str | None
    title: str = Field(min_length=1, max_length=64)
    icon: str
    order: int = Field(ge=0, le=10000)
    visible: bool
    roleIds: list[str] = Field(max_length=100)


class MenuConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: int = Field(ge=1)
    items: list[MenuNode] = Field(max_length=128)


def module_allowed(module_id: str, permissions: list[str]) -> bool:
    module = MODULE_BY_ID[module_id]
    return not module.permissions or bool(
        set(module.permissions).intersection(permissions)
    )


def default_menu_items() -> list[dict]:
    groups = (
        ("access", "用户与权限", "users", 1),
        ("system", "系统管理", "settings", 5),
        ("account", "个人中心", "user", 6),
    )
    items = [
        MenuNode(
            id=key,
            kind="group",
            moduleId=None,
            parentId=None,
            title=title,
            icon=icon,
            order=order,
            visible=True,
            roleIds=[],
        )
        for key, title, icon, order in groups
    ]
    root_order = {"overview": 0, "models": 2, "devices": 3, "workbench": 4}
    child_order: dict[str, int] = {}
    for module in MODULES:
        group = module.id.split(".")[0] if "." in module.id else None
        order = child_order.get(group, 0) if group else root_order[module.id]
        if group:
            child_order[group] = order + 1
        items.append(
            MenuNode(
                id=module.id,
                kind="page",
                moduleId=module.id,
                parentId=group,
                title=module.title,
                icon=module.icon,
                order=order,
                visible=True,
                roleIds=[],
            )
        )
    return [item.model_dump() for item in items]


def validate_menu_items(items: list[dict], role_ids: set[str]) -> None:
    by_id = {item["id"]: item for item in items}
    if len(by_id) != len(items):
        raise ValueError("menu node ids must be unique")
    pages: set[str] = set()
    for item in items:
        if item["title"] != item["title"].strip() or not item["title"].strip():
            raise ValueError("menu titles must be non-empty and trimmed")
        if item["icon"] not in ICONS:
            raise ValueError("unknown menu icon")
        if len(set(item["roleIds"])) != len(item["roleIds"]):
            raise ValueError("menu roles must be unique")
        if set(item["roleIds"]) - role_ids:
            raise ValueError("unknown menu role")
        if item["kind"] == "group":
            if item["moduleId"] is not None or item["parentId"] is not None:
                raise ValueError("groups must be root nodes without a module")
            if item["id"] in MODULE_BY_ID:
                raise ValueError("group id conflicts with a registered page")
            continue
        module_id = item["moduleId"]
        if module_id not in MODULE_BY_ID or item["id"] != module_id:
            raise ValueError("page id must match its registered module")
        pages.add(module_id)
        if item["parentId"] is not None:
            parent = by_id.get(item["parentId"])
            if not parent or parent["kind"] != "group":
                raise ValueError("page parent must be a root group")
    if pages != MODULE_BY_ID.keys():
        raise ValueError("registered pages cannot be added or removed")


def visible_menu_items(
    items: list[dict], *, roles: list[str], permissions: list[str]
) -> list[dict]:
    def shown(item: dict) -> bool:
        return item["visible"] and (
            not item["roleIds"] or bool(set(item["roleIds"]).intersection(roles))
        )

    groups = {
        item["id"]: item for item in items if item["kind"] == "group" and shown(item)
    }
    pages = [
        item
        for item in items
        if item["kind"] == "page"
        and shown(item)
        and module_allowed(item["moduleId"], permissions)
        and (item["parentId"] is None or item["parentId"] in groups)
    ]
    parents = {item["parentId"] for item in pages}
    return sorted(
        pages + [group for key, group in groups.items() if key in parents],
        key=lambda item: (item["parentId"] or "", item["order"], item["id"]),
    )


def assert_menu_edit_allowed(
    old: list[dict], new: list[dict], permissions: list[str]
) -> None:
    """A menu manager may only reorganize pages within their own authority."""
    old_by_id = {item["id"]: item for item in old}
    new_by_id = {item["id"]: item for item in new}
    changed = {
        key
        for key in old_by_id.keys() | new_by_id.keys()
        if old_by_id.get(key) != new_by_id.get(key)
    }
    for item in old + new:
        if (
            item["kind"] == "page"
            and (item["id"] in changed or item["parentId"] in changed)
            and not module_allowed(item["moduleId"], permissions)
        ):
            raise PermissionError("cannot configure a page above your authority")

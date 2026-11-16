"""把一份模块注册目录装配成两个产品各自可编辑的二级菜单。"""

from typing import Any

from app.modules.navigation.entity.bo.navigation import MenuCatalog, Product
from app.modules.navigation.service.rules import validate_items


def menu_node(source: dict[str, Any], parent: str | None, order: int) -> dict[str, object]:
    """分组和页面共用同一个菜单 DTO；只有页面具有模块标识。"""
    identifier = source["id"]
    return {
        "id": identifier,
        "kind": "page" if parent else "group",
        "moduleId": identifier if parent else None,
        "parentId": parent,
        "title": source["title"],
        "icon": source["icon"],
        "order": order,
        "visible": True,
        "roleIds": [],
    }


def product_catalogs(config: dict[str, Any]) -> dict[Product, MenuCatalog]:
    result: dict[Product, MenuCatalog] = {}
    for product in ("office", "entertainment"):
        modules = []
        for source in config["modules"]:
            if source.get("product", product) != product:
                continue
            permissions = list(source["permissions"])
            if action := source.get("productAction"):
                permissions.append(f"products.{product}.{action}.manage")
            modules.append({**source, "permissions": permissions})
        by_id = {module["id"]: module for module in modules}
        defaults: list[dict[str, object]] = []
        for group in config["groups"]:
            if group.get("product", product) != product:
                continue
            defaults.append(menu_node(group, None, len(defaults)))
            defaults.extend(
                menu_node(by_id[key], group["id"], pos) for pos, key in enumerate(group["pages"])
            )
        validate_items(defaults, modules, config["icons"])
        result[product] = MenuCatalog(modules, defaults)
    return result

"""素材中心拆分菜单，只扩展原入口，不扩大管理员配置的可见范围。"""

from copy import deepcopy
from typing import Any


def library_navigation_items(source: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """保留自定义名称、分组和角色限制；重复执行不再产生页面或调整顺序。"""
    items = deepcopy(source)
    for item in items:
        if item.get("moduleId") == "studio.environments" and item["title"] == "场景与道具":
            item["title"] = "场景库"
        if item.get("moduleId") == "studio.library" and item["title"] == "媒体素材":
            item["title"] = "媒体库"
    if any(item.get("moduleId") == "studio.props" for item in items):
        return items
    template = next((item for item in items if item.get("moduleId") == "studio.environments"), None)
    if template is None:
        # 管理员已移除场景入口时，不在另一分组悄悄恢复相同范围的道具访问。
        return items
    occupied = {item["id"] for item in items}
    identifier = "studio.props"
    while identifier in occupied:
        identifier += "-new"
    order = int(template["order"]) + 1
    for item in items:
        if item.get("parentId") == template["parentId"] and int(item["order"]) >= order:
            item["order"] = int(item["order"]) + 1
    items.append(
        {
            **template,
            "id": identifier,
            "moduleId": "studio.props",
            "title": "道具库",
            "icon": "folder",
            "order": order,
        }
    )
    return items

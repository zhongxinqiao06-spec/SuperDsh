"""已保存的同范围入口合并一次。各视图有独立可见性配置时保留原数据。"""

from typing import Any


def merge_member_entries(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    members = next((i for i in items if i["moduleId"] == "product.members"), None)
    users = next((i for i in items if i["moduleId"] == "access.users"), None)
    if not members or not users or any(i["id"] == "product.directory" for i in items):
        return items
    if any(members[k] != users[k] for k in ("visible", "roleIds", "parentId")):
        return items
    if members["title"] != "产品成员" or users["title"] not in {"账号与角色", "用户管理"}:
        return items
    return [
        {**i, "id": "product.directory", "moduleId": "product.directory", "title": "成员与账号"}
        if i is members
        else i
        for i in items
        if i is not users
    ]

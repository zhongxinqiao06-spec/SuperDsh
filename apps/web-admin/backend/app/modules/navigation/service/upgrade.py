"""按字段迁移历史菜单覆盖，已使用新版目录的配置不重复写入。"""

from copy import deepcopy
from typing import Any

from app.modules.navigation.entity.bo.navigation import MenuCatalog, Product
from app.modules.navigation.service.member_directory import merge_member_entries


def upgrade_items(
    items: list[dict[str, object]], product: Product, catalog: MenuCatalog, baseline: dict[str, Any]
) -> list[dict[str, object]]:
    if any(i["moduleId"] in ("product.members", "product.directory") for i in items):
        items = merge_member_entries(items)
        if product != "entertainment":
            return items
        if not any(i["moduleId"] == "studio.create" for i in items):
            return add_creation_center(items, catalog)
        return upgrade_studio_home(items)
    defaults = {str(i["id"]): deepcopy(i) for i in catalog.defaults}
    # 早期菜单先恢复两条旧配置的覆盖，再判断是否可以无损合并。
    if "product.directory" in defaults:
        defaults = {
            ("product.members" if key == "product.directory" else key): (
                {
                    **item,
                    "id": "product.members",
                    "moduleId": "product.members",
                    "title": "产品成员",
                }
                if key == "product.directory"
                else item
            )
            for key, item in defaults.items()
        }
        defaults["access.users"] = {
            **defaults["product.members"],
            "id": "access.users",
            "moduleId": "access.users",
            "title": "账号与角色",
        }
    source = list(baseline["office"])
    if product == "entertainment":
        source += baseline["entertainmentAdded"]
    old = {r[0]: dict(zip(baseline["columns"], r, strict=True)) for r in source}
    if product == "entertainment":
        for key, changes in baseline["entertainmentOverrides"].items():
            old[key].update(changes)
    allowed = {m["id"] for m in catalog.modules}
    # 管理员原先可自定义分组 ID。新增同名内置页/组时，保留旧分组和它的子项。
    occupied = set(defaults).union(str(i["id"]) for i in items)
    redirects = {}
    for item in items:
        key = str(item["id"])
        if item["kind"] == "group" and key not in old and (key in defaults or key in allowed):
            suffix = 1
            target = f"legacy-{key[:50]}"
            while target in occupied:
                suffix += 1
                target = f"legacy-{key[:50]}-{suffix}"
            redirects[key] = target
            occupied.add(target)
    previous = {}
    for item in items:
        key = str(item["id"])
        parent = item["parentId"]
        record = {
            **item,
            "id": redirects.get(key, key),
            "parentId": redirects.get(str(parent), parent),
        }
        previous[str(record["id"])] = record
    # 旧分组上配置的角色范围和隐藏状态需要随子项保留，避免升级意外扩大可见范围。
    customized_groups = {
        key
        for key, item in previous.items()
        if item["kind"] == "group"
        and (
            key not in old
            or item["roleIds"]
            or not item["visible"]
            or any(item[k] != old[key][k] for k in ("title", "icon", "order"))
        )
    }
    for key, item in previous.items():
        prior = old.get(key, {})
        changes = {
            k: item[k] for k in ("title", "icon", "order", "parentId") if item[k] != prior.get(k)
        }
        if item["roleIds"] or not item["visible"]:
            changes.update(roleIds=item["roleIds"], visible=item["visible"])
        parent = str(item["parentId"])
        if parent in customized_groups:
            changes["parentId"] = parent
        if key not in old and item["kind"] == "group":
            # 自定义组名即使与新内置组碰巧同名，也需要保留显式可见性。
            changes.update(visible=item["visible"], roleIds=item["roleIds"])
        if not changes or (item["kind"] == "page" and key not in allowed):
            continue
        if item["kind"] == "group" and key not in customized_groups:
            continue
        if key in defaults:
            defaults[key].update(changes)
        else:
            defaults[key] = deepcopy(item)
        target_parent = defaults[key]["parentId"]
        if target_parent and str(target_parent) not in defaults:
            defaults[str(target_parent)] = deepcopy(previous[str(target_parent)])
    merged = merge_member_entries(list(defaults.values()))
    if product == "entertainment":
        # 早期目录同样可能限制作品入口；先迁移原字段，再由该入口派生创作中心。
        return add_creation_center([i for i in merged if i["moduleId"] != "studio.create"], catalog)
    return merged


def add_creation_center(
    items: list[dict[str, object]], catalog: MenuCatalog
) -> list[dict[str, object]]:
    """从原作品入口继承分组、角色及可见性，已有自定义排序和名称继续生效。"""
    result = deepcopy(items)
    occupied = {i["id"] for i in result}
    if "studio.create" in occupied:
        # 保留管理员自定义的同名分组和它的子项，给新内置模块让出固定 ID。
        suffix = 1
        while f"legacy-studio-create-{suffix}" in occupied:
            suffix += 1
        for item in result:
            for field in ("id", "parentId"):
                if item[field] == "studio.create":
                    item[field] = f"legacy-studio-create-{suffix}"
    works = next(i for i in result if i["moduleId"] == "studio.projects")
    entry = next(i for i in catalog.defaults if i["moduleId"] == "studio.create")
    # 先继承原入口的可见范围，再提升默认分组里的首页。
    result.append({**entry, **{k: works[k] for k in ("parentId", "order", "roleIds", "visible")}})
    return upgrade_studio_home(result, added=True)


def upgrade_studio_home(
    items: list[dict[str, object]], *, added: bool = False
) -> list[dict[str, object]]:
    """旧默认入口提升到顶层，保留自定义名称、图标及来自原分组的可见范围。"""
    home = next(i for i in items if i["moduleId"] == "studio.create")
    if home["title"] != "创作中心" and not added:
        return items
    updated = dict(home)
    if home["title"] == "创作中心":
        updated["title"] = "首页"
    if home["icon"] == "sparkles":
        updated["icon"] = "house"
    if home["parentId"] == "studio-workspace":
        group = next(i for i in items if i["id"] == home["parentId"])
        if group["visible"] and not group["roleIds"]:
            updated.update(parentId=None, order=0)
    if home == updated:
        return items
    return [updated if item is home else item for item in items]

"""按字段迁移历史菜单覆盖，已使用新版目录的配置不重复写入。"""

from copy import deepcopy
from typing import Any

from app.modules.navigation.entity.bo.navigation import MenuCatalog, Product


def upgrade_items(
    items: list[dict[str, object]], product: Product, catalog: MenuCatalog, baseline: dict[str, Any]
) -> list[dict[str, object]]:
    if any(i["moduleId"] == "product.members" for i in items):
        return items
    defaults = {str(i["id"]): deepcopy(i) for i in catalog.defaults}
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
    return list(defaults.values())

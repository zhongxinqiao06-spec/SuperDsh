"""验证升级保留自定义分组、祖先限制和幂等，覆盖撞名的真实旧目录。"""

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.modules.navigation.service.catalogs import product_catalogs
from app.modules.navigation.service.rules import validate_items
from app.modules.navigation.service.upgrade import upgrade_items


def test_custom_menu_collision_and_restricted_parent() -> None:
    resources = Path(__file__).resolve().parents[2] / "backend" / "resources"
    baseline = json.loads((resources / "navigation-upgrade.json").read_text("utf-8"))
    config = json.loads((resources / "navigation.json").read_text("utf-8"))
    catalog = product_catalogs(config)["office"]
    modules = {m["id"] for m in catalog.modules}
    legacy = [
        dict(
            zip(baseline["columns"], row, strict=True),
            kind="page" if row[0] in modules else "group",
            moduleId=row[0] if row[0] in modules else None,
            visible=True,
            roleIds=[],
        )
        for row in baseline["office"]
    ]
    assert upgrade_items(legacy, "office", catalog, baseline) == catalog.defaults
    group = dict(
        next(i for i in legacy if i["kind"] == "group"),
        id="product.members",
        title="自定义成员入口",
        roleIds=["office_admin"],
    )
    legacy.append(group)
    next(i for i in legacy if i["id"] == "agents").update(parentId=group["id"], title="办公助手")
    snapshot = deepcopy(legacy)
    result = upgrade_items(legacy, "office", catalog, baseline)
    validate_items(result, catalog.modules)
    by_id = {i["id"]: i for i in result}
    assert by_id["product.members"]["moduleId"] == "product.members"
    assert by_id["agents"]["title"] == "办公助手"
    assert by_id[by_id["agents"]["parentId"]]["roleIds"] == ["office_admin"]
    assert upgrade_items(result, "office", catalog, baseline) == result
    assert legacy == snapshot


def test_creation_center_inherits_existing_works_visibility() -> None:
    resources = Path(__file__).resolve().parents[2] / "backend" / "resources"
    config = json.loads((resources / "navigation.json").read_text("utf-8"))
    catalog = product_catalogs(config)["entertainment"]
    items = [deepcopy(i) for i in catalog.defaults if i["moduleId"] != "studio.create"]
    group = dict(next(i for i in items if i["kind"] == "group"), id="studio.create")
    items.append(group)
    works = next(i for i in items if i["moduleId"] == "studio.projects")
    works.update(
        parentId=group["id"],
        title="我的片单",
        visible=False,
        roleIds=["admin"],
        order=7,
    )
    snapshot = deepcopy(items)
    result = upgrade_items(items, "entertainment", catalog, {})
    validate_items(result, catalog.modules)
    center = next(i for i in result if i["moduleId"] == "studio.create")
    retained = next(i for i in result if i["moduleId"] == "studio.projects")
    assert retained["title"] == "我的片单"
    assert center["parentId"] != "studio.create"
    assert all(center[k] == retained[k] for k in ("parentId", "order", "visible", "roleIds"))
    assert upgrade_items(result, "entertainment", catalog, {}) == result
    assert items == snapshot


@pytest.mark.parametrize("restricted", [False, True])
def test_studio_home_position_preserves_inherited_roles(restricted: bool) -> None:
    resources = Path(__file__).resolve().parents[2] / "backend" / "resources"
    config = json.loads((resources / "navigation.json").read_text("utf-8"))
    catalog = product_catalogs(config)["entertainment"]
    entry = catalog.defaults[0]
    assert (entry["moduleId"], entry["title"], entry["parentId"], entry["order"]) == (
        "studio.create",
        "首页",
        None,
        0,
    )
    items = deepcopy(catalog.defaults)
    original = items[0]
    original.update(parentId="studio-workspace", order=2, title="创作中心", icon="sparkles")
    group = next(i for i in items if i["id"] == "studio-workspace")
    if restricted:
        group["roleIds"] = ["entertainment_admin"]
    upgraded = upgrade_items(items, "entertainment", catalog, {})
    validate_items(upgraded, catalog.modules)
    home = upgraded[0]
    assert (home["title"], home["icon"]) == ("首页", "house")
    assert home["parentId"] == ("studio-workspace" if restricted else None)
    assert home["order"] == (2 if restricted else 0)
    assert upgraded[1:] == items[1:]
    assert upgrade_items(upgraded, "entertainment", catalog, {}) == upgraded


@pytest.mark.parametrize("icon", ["box", "custom-props-icon", "自定义图标", ""])
def test_legacy_props_icon_survives_creation_center_upgrade(icon: str) -> None:
    """旧库和自定义图标不依赖图标目录；新增创作中心仍保留原菜单设置。"""
    resources = Path(__file__).resolve().parents[2] / "backend" / "resources"
    config = json.loads((resources / "navigation.json").read_text("utf-8"))
    catalog = product_catalogs(config)["entertainment"]
    previous = [deepcopy(i) for i in catalog.defaults if i["moduleId"] != "studio.create"]
    props = next(i for i in previous if i["moduleId"] == "studio.props")
    props.update(icon=icon, title="本片道具", visible=False, roleIds=["entertainment_creator"])
    original = deepcopy(previous)
    upgraded = upgrade_items(previous, "entertainment", catalog, {})
    validate_items(upgraded, catalog.modules)
    assert next(i for i in upgraded if i["moduleId"] == "studio.props") == props
    assert upgrade_items(upgraded, "entertainment", catalog, {}) == upgraded
    assert previous == original

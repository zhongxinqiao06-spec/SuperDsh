"""验证升级保留自定义分组、祖先限制和幂等，覆盖撞名的真实旧目录。"""

import json
from copy import deepcopy
from pathlib import Path

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
    validate_items(result, catalog.modules, config["icons"])
    by_id = {i["id"]: i for i in result}
    assert by_id["product.members"]["moduleId"] == "product.members"
    assert by_id["agents"]["title"] == "办公助手"
    assert by_id[by_id["agents"]["parentId"]]["roleIds"] == ["office_admin"]
    assert upgrade_items(result, "office", catalog, baseline) == result
    assert legacy == snapshot

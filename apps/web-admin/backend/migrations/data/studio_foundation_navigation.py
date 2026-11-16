"""一次性升级娱乐导航，保留既有隐藏、角色范围和自定义分组。"""

from copy import deepcopy

import sqlalchemy as sa


def upgrade_navigation(connection: sa.Connection) -> None:
    row = connection.execute(
        sa.text("SELECT items FROM navigation_settings WHERE id='entertainment' FOR UPDATE")
    ).scalar_one_or_none()
    if row is None:
        return
    items = deepcopy(row)
    by_id = {item["id"]: item for item in items}
    workspace = next(
        (item for item in items if item["id"] == "studio-workspace" and item["kind"] == "group"),
        None,
    )
    library = next((item for item in items if item["moduleId"] == "studio.library"), None)
    if workspace is None:
        # 自定义菜单不强行搬迁；新入口放在现有作品分组，沿用该组限制。
        project = next((item for item in items if item["moduleId"] == "studio.projects"), None)
        workspace = by_id.get(project["parentId"]) if project else None
    template = {
        "roleIds": [],
        "visible": True,
        **({key: workspace[key] for key in ("roleIds", "visible")} if workspace else {}),
    }
    assets_id = "studio-assets"
    while assets_id in by_id:
        assets_id += "-new"
    assets = {
        "id": assets_id,
        "moduleId": None,
        "kind": "group",
        "parentId": None,
        "title": "素材中心",
        "icon": "book-open",
        "order": int(workspace["order"] if workspace else 0) + 1,
        **template,
    }
    items.append(assets)
    if library and library["parentId"] == "studio-workspace":
        library["parentId"] = assets_id
        library["order"] = 2
    for item in items:
        if item["moduleId"] == "studio.projects" and item["title"] == "作品项目":
            item["title"] = "我的作品"
        if item["moduleId"] == "studio.library" and item["title"] == "素材库":
            item["title"] = "媒体素材"
    for index, (key, title, icon) in enumerate(
        (
            ("characters", "角色库", "users"),
            ("environments", "场景与道具", "book-open"),
            ("deliveries", "成片交付", "folder"),
        )
    ):
        module = "studio." + key
        if any(item["moduleId"] == module for item in items):
            continue
        identifier = module
        while identifier in by_id:
            identifier += "-new"
        items.append(
            {
                "id": identifier,
                "moduleId": module,
                "kind": "page",
                "parentId": workspace["id"] if key == "deliveries" and workspace else assets_id,
                "title": title,
                "icon": icon,
                "order": index,
                **template,
            }
        )
    connection.execute(
        sa.text(
            "UPDATE navigation_settings SET items=:items,version=version+1 WHERE id='entertainment'"
        ).bindparams(sa.bindparam("items", type_=sa.JSON)),
        {"items": items},
    )

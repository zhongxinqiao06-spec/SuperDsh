"""作品迁移范围与无物理外键引用校验；不把证据记录当作可执行状态。"""

from typing import Any


def project_scope(manifest: dict[str, Any], values: dict[str, list[dict]]) -> set[str]:
    """旧包严格单作品；新包按明确类型验证整剧及全部活动/历史集的闭包。"""
    projects = values.get("studio_projects", [])
    ids = {row["id"] for row in projects}
    if len(ids) != len(projects):
        raise ValueError("作品身份重复")
    if manifest.get("format") == "superdsh-studio-project-transfer":
        if len(projects) != 1 or ids != {manifest.get("projectId")}:
            raise ValueError("迁移包必须且只能包含指定作品")
        if any(
            values.get(table)
            for table in (
                "studio_series",
                "studio_series_episodes",
                "studio_series_setting_versions",
            )
        ):
            raise ValueError("单作品包不能包含未声明的整剧归属")
        return ids
    work = manifest.get("work") or {}
    if (
        work.get("kind") not in {"quick", "storyboard", "series"}
        or set(work.get("projectIds", [])) != ids
        or len(work.get("projectIds", [])) != len(ids)
        or work.get("id") != manifest.get("projectId")
    ):
        raise ValueError("作品范围与迁移清单不一致")
    series = values.get("studio_series", [])
    episodes = values.get("studio_series_episodes", [])
    if work["kind"] != "series":
        if len(projects) != 1 or ids != {work["id"]} or series or episodes:
            raise ValueError("独立作品包范围不正确")
        if projects[0].get("creation_mode", "storyboard") != work["kind"]:
            raise ValueError("作品模式与清单不一致")
    else:
        if len(series) != 1 or series[0]["id"] != work["id"]:
            raise ValueError("整剧根对象缺失或超出范围")
        if {ep["project_id"] for ep in episodes} != ids or len(episodes) != len(ids):
            raise ValueError("整剧包必须包含全部声明分集工程且归属唯一")
        if any(ep["series_id"] != work["id"] for ep in episodes):
            raise ValueError("分集属于其他整剧")
        if any(
            row.get("series_id") != work["id"]
            for table in (
                "studio_series_setting_versions",
                "studio_series_commands",
                "studio_series_proposals",
                "studio_series_structure_plans",
            )
            for row in values.get(table, [])
        ):
            raise ValueError("整剧关联记录超出范围")
        if any(project.get("creation_mode", "storyboard") != "storyboard" for project in projects):
            raise ValueError("分集必须关联专业分镜工程")
    return ids


def check_logical_references(values: dict[str, list[dict]]) -> None:
    """检查快速草稿、设定快照和素材来源基线，补齐 JSON/多态关联的数据库盲区。"""
    versions = {
        row["id"]
        for table in ("studio_entity_versions", "studio_asset_versions")
        for row in values.get(table, [])
    }
    families = {
        row["id"]
        for table in ("studio_entities", "studio_asset_families")
        for row in values.get(table, [])
    }
    variants = {row["id"] for row in values.get("studio_entity_variants", [])}
    for row in values.get("studio_projects", []):
        if set((row.get("quick_draft") or {}).get("references", [])) - versions:
            raise ValueError("快速草稿引用的素材版本缺失")
    personal_entities = {
        row["id"] for row in values.get("studio_entities", []) if row.get("project_id") is None
    }
    personal_families = {
        row["id"]
        for row in values.get("studio_asset_families", [])
        if row.get("project_id") is None
    }
    personal_versions = {
        row["id"]
        for row in values.get("studio_entity_versions", [])
        if row["entity_id"] in personal_entities
    } | {
        row["id"]
        for row in values.get("studio_asset_versions", [])
        if row["family_id"] in personal_families
    }
    for row in values.get("studio_series_setting_versions", []):
        if set(row["asset_version_ids"]) - personal_versions:
            raise ValueError("本剧设定缺少明确的个人库版本")
    for row in values.get("studio_library_bindings", []):
        if {row["project_family_id"], row["library_family_id"]} - families:
            raise ValueError("素材来源绑定缺少家族")
        if row.get("project_variant_id") and row["project_variant_id"] not in variants:
            raise ValueError("素材来源绑定缺少本片造型")
        needed = {
            row.get(key)
            for key in ("imported_version_id", "published_version_id", "project_version_id")
        }
        needed.update((row.get("field_versions") or {}).values())
        if needed - {None, ""} - versions:
            raise ValueError("素材来源绑定缺少字段基线版本")

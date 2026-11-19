"""导出单条快速作品或完整系列短剧；复用静态作品包，不导出可重放执行状态。"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

if TYPE_CHECKING:
    from app.infrastructure.database import Database


def merge_rows(target: dict[str, list[dict]], incoming: dict[str, list[dict]]) -> None:
    """同一只读事务内共享素材行去重；不按名称合并身份。"""
    for table, entries in incoming.items():
        merged = {
            json.dumps(row, sort_keys=True, default=str, ensure_ascii=False): row
            for row in [*target.get(table, []), *entries]
        }
        target[table] = list(merged.values())


async def export_work_bundle(
    database: Database,
    identity: str,
    kind: str,
    runtime: Path,
    destination: Path,
    *,
    archive_inactive: bool = False,
) -> dict[str, Any]:
    """整剧以一份一致性快照导出所有活动/历史分集和固定版本设定。"""
    from tooling.export_studio_project import (
        PROJECT_TABLES,
        collect,
        complete_dependencies,
        rows,
        write_bundle,
    )

    if kind not in {"quick", "storyboard", "series"}:
        raise ValueError("未知作品类型")
    if await asyncio.to_thread(destination.exists):
        raise ValueError("目标目录已存在，拒绝覆盖历史迁移包")
    async with database.sessions() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        history: list[dict] | None = [] if archive_inactive else None
        evidence: list[dict] = []
        if kind != "series":
            data, evidence, owner = await collect(session, identity, history)
            project = data["studio_projects"][0]
            if project.get("creation_mode", "storyboard") != kind:
                raise ValueError("作品分类与指定类型不一致")
            scope = {
                "kind": kind,
                "id": identity,
                "projectIds": [identity],
                "revision": project["revision"],
            }
        else:
            series = await rows(session, "studio_series", "id", [identity])
            if len(series) != 1:
                raise ValueError("指定整剧不存在")
            owner = str(series[0]["owner"])
            data = {"studio_series": series}
            for table in (
                "studio_series_setting_versions",
                "studio_series_episodes",
                "studio_series_commands",
                "studio_series_proposals",
                "studio_series_structure_plans",
            ):
                data[table] = await rows(session, table, "series_id", [identity])
            episodes = data["studio_series_episodes"]
            if any(episode["owner"] != owner for episode in episodes):
                raise ValueError("分集包含其他账号，停止导出")
            project_ids = sorted(episode["project_id"] for episode in episodes)
            if len(set(project_ids)) != len(project_ids):
                raise ValueError("分集工程归属重复")
            settings = list(
                dict.fromkeys(
                    version
                    for setting in data["studio_series_setting_versions"]
                    for version in setting["asset_version_ids"]
                )
            )
            for project_id in project_ids:
                project_rows, project_evidence, project_owner = await collect(
                    session, project_id, history, series_scope=identity, extra_references=settings
                )
                if project_owner != owner:
                    raise ValueError("整剧与分集所有者不一致")
                merge_rows(data, project_rows)
                evidence.extend(project_evidence)
            if not project_ids:
                # 尚未分集的整剧仍可携带本剧共用的个人设定和文件。
                data.update({table: [] for table in PROJECT_TABLES})
                data["studio_projects"] = []
                await complete_dependencies(session, data, owner, identity)
            scope = {
                "kind": kind,
                "id": identity,
                "projectIds": project_ids,
                "revision": series[0]["revision"],
            }
        schema = await session.scalar(text("SELECT version_num FROM alembic_version"))
        await session.rollback()
    return await asyncio.to_thread(
        write_bundle, data, evidence, owner, identity, runtime, destination, schema, history, scope
    )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", required=True)
    parser.add_argument("--kind", choices=["quick", "storyboard", "series"], required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--archive-inactive", action="store_true")
    parser.add_argument("--development", action="store_true")
    options = parser.parse_args()
    from app.infrastructure.configuration import Settings
    from app.infrastructure.database import Database

    if options.development:
        from main import load_development_environment

        await asyncio.to_thread(load_development_environment)
    root = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    destination = await asyncio.to_thread(options.destination.resolve)
    if not destination.is_relative_to(root / ".superdsh-work/web-admin-validation"):
        raise ValueError("导出目录必须位于隔离验证目录")
    settings = Settings()
    database = Database(settings.database_url)
    try:
        result = await export_work_bundle(
            database,
            options.id,
            options.kind,
            settings.data_dir,
            destination,
            archive_inactive=options.archive_inactive,
        )
        print(
            json.dumps(
                {"work": result["work"], "rows": result["rows"], "files": len(result["files"])},
                ensure_ascii=False,
            )
        )
    finally:
        await database.close()


if __name__ == "__main__":
    sys.path[:0] = [
        str(Path(__file__).resolve().parents[2] / "backend"),
        str(Path(__file__).resolve().parents[1]),
    ]
    asyncio.run(main())

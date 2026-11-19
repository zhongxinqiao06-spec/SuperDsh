"""受限作品导入：默认只检查，显式 --apply 才提交；不恢复历史执行队列。"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, MetaData, Table, and_, bindparam, insert, select, text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from app.infrastructure.database import Database

# 根对象先插入；current_version 延迟外键在全部行完成后显式验证。
IMPORT_ORDER = (
    "studio_series",
    "studio_series_setting_versions",
    "studio_projects",
    "web_file_entries",
    "studio_entities",
    "studio_asset_families",
    "studio_entity_variants",
    "studio_entity_versions",
    "studio_media_jobs",
    "studio_asset_versions",
    "studio_entity_version_assets",
    "studio_scripts",
    "studio_story_scenes",
    "studio_shots",
    "studio_lines",
    "studio_project_assets",
    "studio_project_entity_versions",
    "studio_shot_references",
    "studio_timelines",
    "studio_tracks",
    "studio_clips",
    "studio_revisions",
    "studio_project_snapshots",
    "studio_stage_reviews",
    "studio_proposals",
    "studio_job_actions",
    "studio_library_bindings",
    "studio_series_episodes",
    "web_file_references",
)
OWNER_FIELDS = {"owner", "owner_id", "actor_id"}


@dataclass
class Transfer:
    """已验证的静态包；文件与数据库输入保持一一对应。"""

    root: Path
    manifest: dict[str, Any]
    rows: dict[str, list[dict[str, Any]]]
    files: list[dict[str, Any]]


def check_file_references(values: dict[str, list[dict[str, Any]]], project: str | set[str]) -> None:
    """文件域部分关联没有数据库外键，迁移时必须独立验证范围闭包。"""
    files = {item["id"] for item in values.get("web_file_entries", [])}
    resources = {project} if isinstance(project, str) else set(project)
    for table in (
        "studio_media_jobs",
        "studio_entities",
        "studio_entity_versions",
        "studio_asset_families",
        "studio_asset_versions",
    ):
        resources.update(item["id"] for item in values.get(table, []))
    if any(
        item.get("previous_file_id") not in files | {None}
        for item in values.get("web_file_entries", [])
    ):
        raise ValueError("缺少前一文件版本，不能导入不完整文件链")
    if any(
        item["file_id"] not in files or item["resource_id"] not in resources
        for item in values.get("web_file_references", [])
    ):
        raise ValueError("文件引用超出本作品迁移范围")


def checked_path(root: Path, value: str) -> Path:
    """路径必须留在给定根内，且路径链不得包含符号链接。"""
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("文件路径越界")
    root = root.resolve()
    candidate = root / relative
    if not candidate.resolve().is_relative_to(root) or candidate.resolve() == root:
        raise ValueError("文件路径越界")
    cursor = candidate
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError("导入路径不接受符号链接")
        cursor = cursor.parent
    return candidate


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_bundle(root: Path) -> Transfer:
    """只接受导出白名单和清单内校验通过的文件，不执行包内代码。"""
    from tooling.export_studio_project import ALLOWLIST, sanitized
    from tooling.studio_transfer_scope import check_logical_references, project_scope

    root = root.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") not in {
        "superdsh-studio-project-transfer",
        "superdsh-studio-work-transfer",
    }:
        raise ValueError("不是受支持的作品迁移包")
    if sum(entry.get("path") == "rows.json" for entry in manifest.get("dataFiles", [])) != 1:
        raise ValueError("迁移包必须包含 rows.json 的唯一摘要记录")
    values = json.loads((root / "rows.json").read_text(encoding="utf-8"))
    if not isinstance(values, dict) or set(values) - ALLOWLIST:
        raise ValueError("迁移包包含白名单外数据表")
    if any(
        not isinstance(items, list) or not all(isinstance(item, dict) for item in items)
        for items in values.values()
    ):
        raise ValueError("迁移数据行格式错误")
    if manifest.get("rows") != {table: len(items) for table, items in values.items()}:
        raise ValueError("数据行数量与清单不一致")
    redacted: list[str] = []
    sanitized(values, redacted)
    if redacted:
        raise ValueError("迁移包仍包含非空密钥、密文或执行租约")
    projects = values.get("studio_projects", [])
    project_ids = project_scope(manifest, values)
    owner = manifest["sourceOwnerId"]
    check_file_references(values, project_ids)
    check_logical_references(values)
    if any(row["owner"] != owner for row in [*projects, *values.get("studio_series", [])]):
        raise ValueError("作品所有者与清单不一致")
    for table in IMPORT_ORDER:
        for item in values.get(table, []):
            for key in OWNER_FIELDS:
                if item.get(key) not in (None, owner):
                    raise ValueError("迁移包包含其他账号记录")
            for key in ("project", "project_id"):
                if item.get(key) not in project_ids | {None}:
                    raise ValueError("迁移包包含其他作品记录")
    jobs = values.get("studio_media_jobs", [])
    if any(job["state"] != "ready" or job.get("provider_id") is not None for job in jobs):
        raise ValueError("只允许导入无供应商密文的已完成媒体任务")
    expected = {}
    for job in jobs:
        extension = {"speech": ".wav", "image": ".png", "video": ".mp4", "export": ".mp4"}.get(
            job["kind"]
        )
        if extension is None:
            raise ValueError("不支持的媒体类型")
        expected["runtime/studio/media/" + job["id"] + extension] = ("jobId", job["id"])
    for entry in values.get("web_file_entries", []):
        if entry["storage_id"] != "local":
            raise ValueError("当前导入只接受本地对象存储")
        expected["runtime/files/objects/" + entry["object_key"]] = ("fileId", entry["id"])
    files = manifest.get("files", [])
    if len(files) != len(expected) or {entry["path"] for entry in files} != set(expected):
        raise ValueError("媒体与文件清单不完整或包含额外文件")
    for entry in [*files, *manifest.get("dataFiles", []), *manifest.get("evidenceFiles", [])]:
        source = checked_path(root, entry["path"])
        if (
            not source.is_file()
            or source.stat().st_size != entry["bytes"]
            or digest(source) != entry["sha256"]
        ):
            raise ValueError("文件大小或摘要校验失败：" + entry["path"])
        if entry["path"] in expected:
            key, identifier = expected[entry["path"]]
            if entry.get(key) != identifier:
                raise ValueError("文件归属与数据行不一致")
    for entry in values.get("web_file_entries", []):
        metadata = next(item for item in files if item.get("fileId") == entry["id"])
        if metadata["sha256"] != entry["sha256"] or metadata["bytes"] != entry["size"]:
            raise ValueError("文件元数据与对象摘要不一致")
    return Transfer(root, manifest, values, files)


def remap(value: Any, source: str, owner: str, bindings: dict[str, str]) -> Any:
    """只映射所有者和明确的能力绑定字段，保持镜头/媒体/版本身份稳定。"""
    if isinstance(value, list):
        return [remap(item, source, owner, bindings) for item in value]
    if not isinstance(value, dict):
        return value
    result = {
        key: owner
        if key in OWNER_FIELDS and item == source
        else remap(item, source, owner, bindings)
        for key, item in value.items()
    }
    configuration = result.get("configurationId") or result.get("voice_configuration_id")
    revision = (
        result.get("revision")
        if "configurationId" in result
        else result.get("voice_configuration_revision")
    )
    if configuration and revision is not None:
        old = f"{configuration}@{revision}"
        target = bindings.get(old, old)
        new_id, new_revision = target.rsplit("@", 1)
        if "configurationId" in result:
            result.update(configurationId=new_id, revision=int(new_revision))
        else:
            result.update(
                voice_configuration_id=new_id, voice_configuration_revision=int(new_revision)
            )
    elif configuration and "configurationId" in result:
        # 快速草稿只有配置身份，没有冻结模型修订；显式 ID 映射，不伪造修订号。
        result["configurationId"] = bindings.get(str(configuration), str(configuration)).split(
            "@", 1
        )[0]
    return result


def prepare_rows(
    transfer: Transfer, owner: str, bindings: dict[str, str]
) -> dict[str, list[dict[str, Any]]]:
    result = {
        table: remap(
            copy.deepcopy(transfer.rows.get(table, [])),
            transfer.manifest["sourceOwnerId"],
            owner,
            bindings,
        )
        for table in IMPORT_ORDER
    }
    for project in result["studio_projects"]:
        project["session_id"] = None
    for row in result["studio_media_jobs"]:
        row["provider_id"] = None
        row["cancel_requested"] = False
        row["payload"].pop("planId", None)
    return result


def typed_row(table: Table, row: dict[str, Any]) -> dict[str, Any]:
    if set(row) - set(table.columns.keys()):
        raise ValueError("数据包含目标表不支持的字段：" + table.name)
    return {
        key: datetime.fromisoformat(value)
        if value is not None and isinstance(table.c[key].type, DateTime)
        else value
        for key, value in row.items()
    }


async def preflight(
    connection: AsyncConnection,
    transfer: Transfer,
    owner: str,
    values: dict[str, list[dict[str, Any]]],
    *,
    reuse_identical: bool = False,
) -> tuple[MetaData, dict[str, set[str]]]:
    """检查目标账号、schema、ID 冲突和全部外键；不导入账号或更改权限。"""
    schema = await connection.scalar(text("SELECT version_num FROM alembic_version"))
    if not transfer.manifest.get("schemaRevision") or schema != transfer.manifest["schemaRevision"]:
        raise ValueError("目标数据库迁移版本与包不一致，请先部署对应代码并完成迁移")
    user = (
        (
            await connection.execute(
                text("SELECT roles,disabled,deleted_at,reset_required FROM users WHERE id=:id"),
                {"id": owner},
            )
        )
        .mappings()
        .one_or_none()
    )
    if not user or user["disabled"] or user["deleted_at"] or user["reset_required"]:
        raise ValueError("目标账号不存在或不可用")
    role_query = text("SELECT permissions FROM roles WHERE id IN :ids").bindparams(
        bindparam("ids", expanding=True)
    )
    role_permissions: list[list[str]] = list(
        (await connection.execute(role_query, {"ids": user["roles"]})).scalars()
    )
    grants = {permission for permissions in role_permissions for permission in permissions}
    if not {"products.entertainment", "studio.projects.read", "studio.projects.write"} <= grants:
        raise ValueError("目标账号缺少娱乐作品权限")
    metadata = MetaData()
    reused: dict[str, set[str]] = {name: set() for name in IMPORT_ORDER}
    await connection.run_sync(lambda sync: metadata.reflect(sync, only=list(IMPORT_ORDER)))
    for table_name, records in values.items():
        table = metadata.tables[table_name]
        for original in records:
            row = typed_row(table, original)
            primary = and_(
                *(table.c[column.name] == row[column.name] for column in table.primary_key)
            )
            existing = (
                (await connection.execute(select(table).where(primary))).mappings().one_or_none()
            )
            if existing is not None:
                if not reuse_identical or any(
                    existing.get(key) != value for key, value in row.items()
                ):
                    raise ValueError("目标存在同 ID 记录或基线不一致，拒绝覆盖：" + table_name)
                reused[table_name].add(row_identity(table, row))
            for constraint in table.foreign_key_constraints:
                parts = list(constraint.elements)
                target = parts[0].column.table
                keys = [part.parent.name for part in parts]
                if any(row.get(key) is None for key in keys):
                    continue
                referenced = {part.column.name: row[part.parent.name] for part in parts}
                if any(
                    all(candidate.get(key) == value for key, value in referenced.items())
                    for candidate in values.get(target.name, [])
                ):
                    continue
                # 外部依赖只有已验证的目标用户和配置版本；其余缺项必须显式补全。
                if target.name not in {"users", "model_configuration_versions"}:
                    raise ValueError("包缺少关联记录：" + table_name + " -> " + target.name)
                query = (
                    select(1)
                    .select_from(target)
                    .where(and_(*(target.c[key] == value for key, value in referenced.items())))
                )
                if not await connection.scalar(query.limit(1)):
                    raise ValueError("目标缺少关联记录：" + table_name + " -> " + target.name)
    for job in values["studio_media_jobs"]:
        binding = job["payload"].get("binding")
        if not binding:
            continue
        model = (
            (
                await connection.execute(
                    text(
                        "SELECT v.definition,c.enabled FROM model_configuration_versions v JOIN model_configurations c ON c.id=v.configuration_id "
                        "WHERE v.configuration_id=:id AND v.revision=:revision"
                    ),
                    {"id": binding["configurationId"], "revision": binding["revision"]},
                )
            )
            .mappings()
            .one_or_none()
        )
        if (
            not model
            or not model["enabled"]
            or model["definition"].get("capability") != binding["capability"]
        ):
            raise ValueError("目标媒体模型绑定不可用：" + binding["configurationId"])
    for project in values["studio_projects"]:
        configuration = (project.get("quick_draft") or {}).get("configurationId")
        if not configuration:
            continue
        available = await connection.scalar(
            text(
                "SELECT 1 FROM model_configurations WHERE id=:id AND enabled=true AND capability='video.generate'"
            ),
            {"id": configuration},
        )
        if not available:
            raise ValueError("目标快速视频模型配置不可用：" + configuration)
    return metadata, reused


def row_identity(table: Table, row: dict[str, Any]) -> str:
    """只用于本次预检结果索引，不生成或改写持久身份。"""
    return json.dumps([row[column.name] for column in table.primary_key], default=str)


def ordered(records: list[dict[str, Any]], parent_key: str) -> list[dict[str, Any]]:
    pending = {row["id"]: row for row in records}
    result = []
    while pending:
        available = [row for row in pending.values() if row.get(parent_key) not in pending]
        if not available:
            raise ValueError("版本来源链有循环")
        for row in available:
            result.append(row)
            del pending[row["id"]]
    return result


def publish_files(transfer: Transfer, runtime: Path, created: list[Path]) -> None:
    """逐文件原子发布且绝不覆盖；记录仅本次新文件供事务失败回滚。"""
    runtime.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="studio-import-", dir=runtime) as staging:
        for entry in transfer.files:
            relative = entry["path"].removeprefix("runtime/")
            target = checked_path(runtime, relative)
            if target.exists():
                if digest(target) != entry["sha256"]:
                    raise ValueError("目标文件冲突：" + relative)
                continue
            source = checked_path(transfer.root, entry["path"])
            temporary = Path(staging) / str(len(created))
            with source.open("rb") as incoming, temporary.open("xb") as outgoing:
                while block := incoming.read(1024 * 1024):
                    outgoing.write(block)
            if digest(temporary) != entry["sha256"]:
                raise ValueError("复制期间文件摘要发生变化")
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(temporary, target)
            created.append(target)


def check_target_files(transfer: Transfer, runtime: Path) -> None:
    for entry in transfer.files:
        target = checked_path(runtime, entry["path"].removeprefix("runtime/"))
        if target.exists() and (not target.is_file() or digest(target) != entry["sha256"]):
            raise ValueError("目标文件内容冲突")


def rollback_files(runtime: Path, created: list[Path]) -> None:
    """只删除本轮记录且仍在目标根内的新文件，不递归删除任何现有目录。"""
    root = runtime.resolve()
    for path in reversed(created):
        if path.resolve().is_relative_to(root) and path.is_file() and not path.is_symlink():
            path.unlink()


async def import_bundle(
    database: Database,
    source: Path,
    runtime: Path,
    owner: str,
    *,
    apply: bool = False,
    bindings: dict[str, str] | None = None,
    reuse_identical: bool = False,
) -> dict[str, Any]:
    """默认 dry-run。单事务导入；数据库失败回滚本轮新文件，既有数据不变。"""
    transfer = await asyncio.to_thread(load_bundle, source)
    values = prepare_rows(transfer, owner, bindings or {})
    await asyncio.to_thread(check_target_files, transfer, runtime)
    created: list[Path] = []
    commit_started = False
    try:
        async with database.engine.begin() as connection:
            if not apply:
                await connection.execute(text("SET TRANSACTION READ ONLY"))
            else:
                await connection.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                    {"key": "studio-import:" + transfer.manifest["projectId"]},
                )
            metadata, reused = await preflight(
                connection, transfer, owner, values, reuse_identical=reuse_identical
            )
            if apply:
                await connection.execute(text("SET CONSTRAINTS ALL DEFERRED"))
                for table_name in IMPORT_ORDER:
                    records = values[table_name]
                    parent = {
                        "studio_entity_versions": "origin_version_id",
                        "studio_asset_versions": "parent_version_id",
                    }.get(table_name)
                    if parent:
                        records = ordered(records, parent)
                    for row in records:
                        if row_identity(metadata.tables[table_name], row) in reused[table_name]:
                            continue
                        await connection.execute(
                            insert(metadata.tables[table_name]).values(
                                **typed_row(metadata.tables[table_name], row)
                            )
                        )
                await connection.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
                # 取消协程不会停止复制线程；必须等发布线程结束再回滚，不能边删边继续复制。
                publication = asyncio.create_task(
                    asyncio.to_thread(publish_files, transfer, runtime, created)
                )
                try:
                    await asyncio.shield(publication)
                except BaseException:
                    await publication
                    raise
                commit_started = True
    except BaseException:
        # 提交时失联不能判断事务是否已落库，保留已发布文件供核对，避免删掉成功工程的媒体。
        # 提交前的任何失败由事务上下文回滚，再只清理本轮新文件；重跑仍拒绝覆盖已有工程。
        if not commit_started:
            await asyncio.to_thread(rollback_files, runtime, created)
        raise
    return {
        "status": "imported" if apply else "dry-run-passed",
        "projectId": transfer.manifest["projectId"],
        "revision": transfer.manifest["revision"],
        "targetOwnerId": owner,
        "tables": {name: len(items) for name, items in values.items()},
        "reusedRows": {name: len(items) for name, items in reused.items() if items},
        "bundleSha256": digest(transfer.root / "manifest.json"),
        "work": transfer.manifest.get("work"),
        "files": len(transfer.files),
        "newFiles": len(created),
        "directorSession": "lazy-create-new",
        "excludedTables": sorted(set(transfer.rows) - set(IMPORT_ORDER)),
        "historyEvidence": str(transfer.root / "evidence"),
        "unknownOperations": "evidence-only; never imported or replayed",
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--model-map", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--reuse-identical",
        action="store_true",
        help="仅复用所有导入列完全一致的目标记录；不允许覆盖",
    )
    parser.add_argument("--development", action="store_true")
    options = parser.parse_args()
    from app.infrastructure.configuration import Settings
    from app.infrastructure.database import Database

    if options.development:
        from main import load_development_environment

        await asyncio.to_thread(load_development_environment)
    mapping = (
        json.loads(await asyncio.to_thread(options.model_map.read_text, encoding="utf-8"))
        if options.model_map
        else {}
    )
    settings = Settings()
    database = Database(settings.database_url)
    try:
        report = await import_bundle(
            database,
            options.bundle,
            settings.data_dir,
            options.owner,
            apply=options.apply,
            bindings=mapping,
            reuse_identical=options.reuse_identical,
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        await database.close()


if __name__ == "__main__":
    sys.path[:0] = [
        str(Path(__file__).resolve().parents[2] / "backend"),
        str(Path(__file__).resolve().parents[1]),
    ]
    asyncio.run(main())

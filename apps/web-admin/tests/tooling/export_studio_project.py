"""只读导出单个作品的受限迁移包；不导出账号、密钥或可恢复执行队列。"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from app.infrastructure.database import Database

# 表名与关联方向固定；禁止扫描全库、users、模型连接和运行租约。
PROJECT_TABLES = {
    "studio_scripts": "project_id",
    "studio_story_scenes": "project_id",
    "studio_shots": "project_id",
    "studio_lines": "project_id",
    "studio_project_assets": "project_id",
    "studio_project_entity_versions": "project_id",
    "studio_shot_references": "project_id",
    "studio_commands": "project_id",
    "studio_project_snapshots": "project_id",
    "studio_revisions": "project",
    "studio_timelines": "project_id",
    "studio_tracks": "project_id",
    "studio_clips": "project_id",
    "studio_stage_reviews": "project_id",
    "studio_proposals": "project_id",
    "studio_text_edits": "project_id",
    "studio_generation_plans": "project",
    "studio_media_jobs": "project",
}
EXTRA_TABLES = {
    "studio_projects",
    "studio_entities",
    "studio_entity_versions",
    "studio_asset_families",
    "studio_asset_versions",
    "studio_entity_version_assets",
    "studio_job_actions",
    "web_file_entries",
    "web_file_references",
    "web_conversations",
    "web_conversation_items",
    "web_conversation_events",
    "web_conversation_receipts",
}
ALLOWLIST = frozenset(PROJECT_TABLES) | EXTRA_TABLES
SENSITIVE_KEYS = {
    "apikey",
    "authorization",
    "credential",
    "credentials",
    "secret",
    "password",
    "accesstoken",
    "refreshtoken",
    "secretciphertext",
    "receiptciphertext",
    "providerid",
    "leasetoken",
    "leaseuntil",
    "signedurl",
    "downloadurl",
    "token",
    "encryptionkey",
    "signingkey",
}
REFERENCE_KEYS = {
    "asset_version_id",
    "entity_version_id",
    "speaker_version_id",
    "current_version_id",
    "assets",
    "references",
    "role",
    "music",
}


def sanitized(value: Any, removed: list[str], path: str = "") -> Any:
    """只保留业务内容；密文不冒充目标实例可用凭据，删除位置登记在清单。"""
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            location = f"{path}.{key}" if path else str(key)
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in SENSITIVE_KEYS or normalized.endswith("ciphertext"):
                result[key] = None
                if item is not None:
                    removed.append(location)
            else:
                result[key] = sanitized(item, removed, location)
        return result
    if isinstance(value, list):
        return [sanitized(item, removed, f"{path}[{i}]") for i, item in enumerate(value)]
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def references(value: Any) -> set[str]:
    """仅跟随工程契约中的素材引用字段，不把用户自由文本当作外键。"""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in REFERENCE_KEYS:
                if isinstance(item, str) and item:
                    found.add(item)
                elif isinstance(item, list):
                    found.update(part for part in item if isinstance(part, str) and part)
            found.update(references(item))
    elif isinstance(value, list):
        for item in value:
            found.update(references(item))
    return found


async def rows(
    session: AsyncSession, table: str, column: str, values: list[str]
) -> list[dict[str, Any]]:
    """白名单表与受控列名，所有业务标识使用绑定参数；空集合绝不退化为全表。"""
    if table not in ALLOWLIST or not re.fullmatch(r"[a-z_]+", column):
        raise ValueError("迁移表或筛选列不在允许范围")
    if not values:
        return []
    query = text(f'SELECT * FROM "{table}" WHERE "{column}" IN :values').bindparams(
        bindparam("values", expanding=True)
    )
    return [dict(row) for row in (await session.execute(query, {"values": values})).mappings()]


def owned(entries: list[dict[str, Any]], owner: str, project: str) -> None:
    """跨作品/跨账号来源必须显式处理，不能借引用链扩大导出范围。"""
    for entry in entries:
        if entry.get("owner_id", owner) != owner:
            raise ValueError("发现其他账号资源，停止导出")
        if entry.get("project_id", project) not in (None, project):
            raise ValueError("发现其他作品资源，停止导出")


async def asset_closure(
    session: AsyncSession, data: dict[str, list[dict[str, Any]]], owner: str, project: str
) -> None:
    """保留作品用到的全部版本和来源链，不收集同账号其他作品的无关素材。"""
    ids = references(data)
    entities = await rows(session, "studio_entities", "project_id", [project])
    families = await rows(session, "studio_asset_families", "project_id", [project])
    entity_versions: dict[str, dict[str, Any]] = {}
    asset_versions: dict[str, dict[str, Any]] = {}
    for _ in range(100):
        previous = (
            len(entities),
            len(families),
            len(entity_versions),
            len(asset_versions),
            len(ids),
        )
        for table, roots, parent, selected in (
            ("studio_entity_versions", entities, "entity_id", entity_versions),
            ("studio_asset_versions", families, "family_id", asset_versions),
        ):
            found = await rows(session, table, parent, [item["id"] for item in roots])
            found += await rows(session, table, "id", list(ids))
            selected.update((item["id"], item) for item in found)
            ids.update(
                str(item[key])
                for item in found
                for key in ("origin_version_id", "parent_version_id")
                if item.get(key)
            )
        entities = list(
            {
                item["id"]: item
                for item in entities
                + await rows(
                    session,
                    "studio_entities",
                    "id",
                    [v["entity_id"] for v in entity_versions.values()],
                )
            }.values()
        )
        families = list(
            {
                item["id"]: item
                for item in families
                + await rows(
                    session,
                    "studio_asset_families",
                    "id",
                    [v["family_id"] for v in asset_versions.values()],
                )
            }.values()
        )
        owned(entities + families, owner, project)
        links = await rows(
            session, "studio_entity_version_assets", "entity_version_id", list(entity_versions)
        )
        ids.update(item["asset_version_id"] for item in links)
        if previous == (
            len(entities),
            len(families),
            len(entity_versions),
            len(asset_versions),
            len(ids),
        ):
            break
    else:
        raise ValueError("素材来源链过长或不稳定")
    data.update(
        {
            "studio_entities": entities,
            "studio_asset_families": families,
            "studio_entity_versions": list(entity_versions.values()),
            "studio_asset_versions": list(asset_versions.values()),
            "studio_entity_version_assets": links,
        }
    )


async def collect(
    session: AsyncSession, project_id: str, history: list[dict[str, Any]] | None = None
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]], str]:
    """在调用方的只读一致性事务内收集单个工程及显式依赖。"""
    projects = await rows(session, "studio_projects", "id", [project_id])
    if len(projects) != 1:
        raise ValueError("指定作品不存在")
    owner = str(projects[0]["owner"])
    data = {"studio_projects": projects}
    for table, column in PROJECT_TABLES.items():
        data[table] = await rows(session, table, column, [project_id])
    if any(job["state"] != "ready" for job in data["studio_media_jobs"]):
        if history is None or any(
            job["state"] not in {"ready", "failed", "cancelled", "unknown", "paused", "unaccepted"}
            or job.get("lease_token")
            or job.get("lease_until")
            for job in data["studio_media_jobs"]
        ):
            raise ValueError("作品仍有未完成任务；先核对状态，不能迁移活动执行队列")
        # 显式归档仅迁移静态证据，未知状态不改成成功，也不进入目标执行表。
        history.extend(job for job in data["studio_media_jobs"] if job["state"] != "ready")
        data["studio_media_jobs"] = [
            job for job in data["studio_media_jobs"] if job["state"] == "ready"
        ]
    await asset_closure(session, data, owner, project_id)
    job_ids = {job["id"] for job in data["studio_media_jobs"]}
    source_jobs = {
        item["source_job_id"] for item in data["studio_asset_versions"] if item.get("source_job_id")
    }
    if source_jobs - job_ids:
        raise ValueError("存在项目外生成来源，需要明确扩展依赖后再导出")
    data["studio_job_actions"] = await rows(session, "studio_job_actions", "job", list(job_ids))
    files: dict[str, dict[str, Any]] = {}
    frontier = {item["file_id"] for item in data["studio_asset_versions"] if item.get("file_id")}
    while frontier:
        found = await rows(session, "web_file_entries", "id", list(frontier))
        if {item["id"] for item in found} != frontier:
            raise ValueError("素材引用的文件记录缺失")
        owned(found, owner, project_id)
        files.update((item["id"], item) for item in found)
        frontier = {
            item["previous_file_id"] for item in found if item.get("previous_file_id")
        } - files.keys()
    data["web_file_entries"] = list(files.values())
    resource_ids = {project_id, *job_ids, *references(data)}
    resource_ids.update(
        item["id"] for table in ("studio_entities", "studio_asset_families") for item in data[table]
    )
    data["web_file_references"] = [
        item
        for item in await rows(session, "web_file_references", "file_id", list(files))
        if item["owner_id"] == owner and item["resource_id"] in resource_ids
    ]
    sessions = {projects[0]["session_id"]} - {None}
    sessions.update(
        item["target"].get("sessionId")
        for item in data["studio_text_edits"]
        if item["target"].get("sessionId")
    )
    for table in (
        "web_conversations",
        "web_conversation_items",
        "web_conversation_events",
        "web_conversation_receipts",
    ):
        data[table] = await rows(
            session, table, "id" if table == "web_conversations" else "session_id", list(sessions)
        )
    if any(item["owner_id"] != owner for item in data["web_conversations"]):
        raise ValueError("导演历史会话不属于作品所有者")
    # 这是只读证据，绝不进入可导入表清单或重放队列；不读取密文值。
    evidence = [
        dict(item)
        for item in (
            await session.execute(
                text(
                    "SELECT id,owner_id,session_id,configuration_id,configuration_revision,state,"
                    "request_id,request_hash,usage,result,error,updated_at,"
                    "receipt_ciphertext IS NOT NULL AS has_encrypted_receipt FROM model_operations "
                    "WHERE owner_id=:owner AND session_id=:scope"
                ),
                {"owner": owner, "scope": "studio-context:" + project_id},
            )
        ).mappings()
    ]
    return data, evidence, owner


def copy_checked(source_root: Path, relative: str, destination: Path) -> dict[str, Any]:
    """只复制根目录内的普通文件并逐字节校验；拒绝绝对路径、链接和路径穿越。"""
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError("文件路径越界")
    source_root = source_root.resolve()
    source = (source_root / relative_path).resolve()
    if not source.is_relative_to(source_root) or source == source_root or not source.is_file():
        raise ValueError("文件缺失或路径越界")
    cursor = source_root / relative_path
    while cursor != source_root:
        if cursor.is_symlink():
            raise ValueError("迁移不接受符号链接")
        cursor = cursor.parent
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)

    def digest(path: Path) -> str:
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    checksum = digest(source)
    if digest(destination) != checksum:
        raise ValueError("复制校验不一致")
    return {"bytes": source.stat().st_size, "sha256": checksum}


async def export_bundle(
    database: Database,
    project: str,
    runtime: Path,
    destination: Path,
    *,
    archive_inactive: bool = False,
) -> dict[str, Any]:
    """生成可审阅的离线源数据包；不声称已完成目标导入和原生会话恢复。"""
    if await asyncio.to_thread(destination.exists):
        raise ValueError("目标目录已存在，拒绝覆盖历史迁移包")
    async with database.sessions() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        history: list[dict[str, Any]] | None = [] if archive_inactive else None
        data, evidence, owner = await collect(session, project, history)
        schema_revision = await session.scalar(text("SELECT version_num FROM alembic_version"))
        await session.rollback()
    return await asyncio.to_thread(
        write_bundle, data, evidence, owner, project, runtime, destination, schema_revision, history
    )


def write_bundle(
    data: dict[str, list[dict[str, Any]]],
    evidence: list[dict[str, Any]],
    owner: str,
    project: str,
    runtime: Path,
    destination: Path,
    schema_revision: str | None,
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """事务结束后在线程中复制已冻结数据；manifest 最后写入表示本地打包完整。"""
    destination.mkdir(parents=True)
    removed: list[str] = []
    clean = sanitized(data, removed, "rows")

    def write(relative: str, value: Any) -> None:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    write("rows.json", clean)
    write("evidence/model-operations.json", sanitized(evidence, removed, "evidence"))
    history_files = []
    if history is not None:
        name = "evidence/inactive-media-jobs.json"
        write(name, sanitized(history, removed, "inactive-media-jobs"))
        history_files.append(
            {
                "path": name,
                "bytes": (destination / name).stat().st_size,
                "sha256": hashlib.sha256((destination / name).read_bytes()).hexdigest(),
            }
        )
    copied = []
    for job in data["studio_media_jobs"]:
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", job["id"]):
            raise ValueError("任务文件标识格式不正确")
        suffix = ".wav" if job["kind"] == "speech" else ".png" if job["kind"] == "image" else ".mp4"
        relative = "studio/media/" + job["id"] + suffix
        copied.append(
            {
                "path": "runtime/" + relative,
                "jobId": job["id"],
                **copy_checked(runtime, relative, destination / "runtime" / relative),
            }
        )
    for entry in data["web_file_entries"]:
        if entry["storage_id"] != "local":
            raise ValueError("当前工具只复制本地对象存储；外部存储必须显式适配")
        # FileService 在 data_dir/files 下装配 StorageService，object_key 本身也可能带 objects/。
        relative = "files/objects/" + entry["object_key"]
        result = copy_checked(runtime, relative, destination / "runtime" / relative)
        if result["sha256"] != entry["sha256"] or result["bytes"] != entry["size"]:
            raise ValueError("源对象与文件元数据不一致")
        copied.append({"path": "runtime/" + relative, "fileId": entry["id"], **result})
    manifest = {
        "format": "superdsh-studio-project-transfer",
        "createdAt": datetime.now(UTC).isoformat(),
        "projectId": project,
        "sourceOwnerId": owner,
        "revision": data["studio_projects"][0]["revision"],
        "schemaRevision": schema_revision,
        "status": "review-required-not-imported",
        "tableAllowlist": sorted(ALLOWLIST),
        "rows": {table: len(items) for table, items in clean.items()},
        "files": copied,
        "dataFiles": [
            {
                "path": name,
                "bytes": (destination / name).stat().st_size,
                "sha256": hashlib.sha256((destination / name).read_bytes()).hexdigest(),
            }
            for name in ("rows.json", "evidence/model-operations.json")
        ],
        "redactedFields": removed,
        "evidenceFiles": history_files,
        "archivedInactiveJobs": len(history or []),
        "importRequirements": [
            "先备份目标，再以单作品事务导入；ID冲突必须停止，不能覆盖现有用户或作品。",
            "显式映射sourceOwnerId到目标已有用户；核验娱乐权限，更新所有owner/owner_id/actor_id及JSON内owner。",
            "核验目标model_configuration_versions和角色voice绑定；模型凭据只由目标后端配置提供。",
            "provider_id和加密回执未导出；ready文件可预览/剪辑，旧任务不能在目标端恢复供应商下载。",
            "model-operations仅作只读证据，unknown保持未知；本地原始记录保留，禁止自动重放。",
            "导演会话仅含可读投影；须映射connector/cwd/native project，重新绑定目标工具与模型。未迁移DSH原生存储，不能承诺原会话续跑。",
            "项目草稿生成计划只作历史；目标确认制作前必须创建新预检，不直接确认本包中的旧计划。",
            "父版本/当前版本存在延迟外键，按依赖导入并在提交前验证；studio_assets是视图，禁止写入。",
        ],
        "excluded": [
            "users",
            "RBAC",
            "passwords",
            "model_connections",
            "model_credentials",
            "storage_credentials",
            "runtime_queues_and_leases",
            "native_DSH_home",
            "encrypted_submission_receipts",
            "active_uploads",
            "other_projects",
        ],
    }
    write("manifest.json", manifest)
    return manifest


async def main() -> None:
    """命令行仅加载本机连接配置，输出统计；从不打印连接字符串或凭据。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument(
        "--archive-inactive",
        action="store_true",
        help="失败和未知任务只存只读证据，不导入执行队列；活动任务仍阻止导出",
    )
    options = parser.parse_args()
    from app.infrastructure.configuration import Settings
    from app.infrastructure.database import Database
    from main import load_development_environment

    root = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    destination = await asyncio.to_thread(options.destination.resolve)
    if not destination.is_relative_to(root / ".superdsh-work/web-admin-validation"):
        raise ValueError("导出目录必须位于隔离验证目录")
    await asyncio.to_thread(load_development_environment)
    settings = Settings()
    database = Database(settings.database_url)
    try:
        result = await export_bundle(
            database,
            options.project,
            settings.data_dir,
            destination,
            archive_inactive=options.archive_inactive,
        )
        print(
            json.dumps(
                {
                    "projectId": result["projectId"],
                    "revision": result["revision"],
                    "tables": len(result["rows"]),
                    "files": len(result["files"]),
                    "status": result["status"],
                }
            )
        )
    finally:
        await database.close()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
    asyncio.run(main())

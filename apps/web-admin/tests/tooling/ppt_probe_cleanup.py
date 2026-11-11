"""PPT 实测账号的本地成果清理清单；先审查路径并移除文件，再清理数据库。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from uuid import UUID

from sqlalchemy import text
from tooling.model_probe_cleanup import EXTERNAL_STATE_GUARDS, cleanup_probe_user

from app.infrastructure.configuration import Settings
from app.infrastructure.database import Database
from main import load_development_environment


async def cleanup(directory: Path, finalize: bool) -> None:
    """仅接受已停止且已禁用的本轮临时账号；不删除文件、不处理远程存储。"""
    repository = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    validation = repository / ".superdsh-work/web-admin-validation/session-lifecycle"
    directory = await asyncio.to_thread(directory.resolve)
    if not directory.is_relative_to(validation) or not directory.name.startswith("live-ppt-"):
        raise ValueError("仅允许本轮 PPT 验证目录")
    evidence = json.loads((directory / "evidence.json").read_text(encoding="utf-8"))
    user_id, username = evidence["userId"], evidence["username"]
    if str(UUID(user_id)) != user_id or not re.fullmatch(r"model_probe_ppt_[a-z0-9]{8}", username):
        raise ValueError("临时身份不匹配")
    if evidence["cleanup"] != {"runtimeStopped": True, "userDisabled": True}:
        raise ValueError("必须先停止 DSH 并禁用临时账号")
    load_development_environment()
    settings = Settings()
    data_root = settings.data_dir.resolve()
    if not data_root.is_relative_to(repository / ".superdsh-work"):
        raise ValueError("禁止清理开发工作目录以外的存储")
    database = Database(settings.database_url)
    parameters = {"user_id": user_id}
    try:
        async with database.engine.begin() as connection:
            lease_key = int.from_bytes(
                hashlib.sha256(f"superdsh:web-admin:runtime:{user_id}".encode()).digest()[:8],
                "big",
                signed=True,
            )
            if not await connection.scalar(
                text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": lease_key}
            ):
                raise RuntimeError("DSH 仍占用租约")
            row = (
                (
                    await connection.execute(
                        text(
                            "SELECT username,roles,disabled,deleted_at,email FROM users WHERE id=:user_id FOR UPDATE"
                        ),
                        parameters,
                    )
                )
                .mappings()
                .one()
            )
            if (
                row["username"] != username
                or row["roles"] != ["member"]
                or not (row["disabled"] or row["deleted_at"])
                or row["email"]
            ):
                raise ValueError("账号身份、角色或禁用状态不符合清理前提")
            guards = [*EXTERNAL_STATE_GUARDS, ("runtime_execution_fences", "owner=:user_id")]
            for table, predicate in guards:
                if table in {"web_file_entries", "artifacts"}:
                    continue
                if await connection.scalar(
                    text(f"SELECT count(*) FROM {table} WHERE {predicate}"), parameters
                ):
                    raise RuntimeError(f"{table} 仍有未核对状态")
            files = (
                (
                    await connection.execute(
                        text(
                            "SELECT id,storage_id,object_key FROM web_file_entries WHERE owner_id=:user_id"
                        ),
                        parameters,
                    )
                )
                .mappings()
                .all()
            )
            paths = []
            for file in files:
                if file["storage_id"] != "local" or not re.fullmatch(
                    r"objects/[a-f0-9]{32}", file["object_key"]
                ):
                    raise ValueError("只清理由本次工具生成的本地对象")
                foreign = await connection.scalar(
                    text(
                        "SELECT count(*) FROM web_file_references WHERE file_id=:file_id AND owner_id<>:user_id"
                    ),
                    {**parameters, "file_id": file["id"]},
                )
                duplicate = await connection.scalar(
                    text(
                        "SELECT count(*) FROM web_file_entries WHERE object_key=:key AND owner_id<>:user_id"
                    ),
                    {**parameters, "key": file["object_key"]},
                )
                if foreign or duplicate:
                    raise ValueError("对象被其他账号引用，拒绝清理")
                paths.append(data_root / "files/objects" / file["object_key"])
            paths.append(data_root / "objects" / user_id)
            for path in paths:
                if not path.resolve().is_relative_to(data_root) or path.is_symlink():
                    raise ValueError("路径越界或为链接")
            manifest = {"userId": user_id, "username": username, "paths": [str(p) for p in paths]}
            (directory / "cleanup-objects.json").write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )
            if not finalize:
                print(
                    json.dumps(
                        {"objects": len(files), "manifest": str(directory / "cleanup-objects.json")}
                    )
                )
                return
            if any(path.exists() for path in paths):
                raise ValueError("先按清单检查并移除物理对象，再提交数据库清理")
            for table in ("web_file_references", "web_file_entries", "artifacts"):
                await connection.execute(
                    text(f"DELETE FROM {table} WHERE owner_id=:user_id"), parameters
                )
        result = await cleanup_probe_user(
            database,
            user_id=user_id,
            username=username,
            runtime_root=settings.runtime_state_root or data_root / "runtime",
        )
        (directory / "cleanup.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        counts = result["removed"]
        assert isinstance(counts, dict)
        print(
            json.dumps(
                {
                    "removedRows": sum(counts.values()),
                    "runtimeDirectory": result["runtimeDirectory"],
                }
            )
        )
    finally:
        await database.close()


if __name__ == "__main__":
    asyncio.run(cleanup(Path(sys.argv[1]), "--finalize" in sys.argv[2:]))

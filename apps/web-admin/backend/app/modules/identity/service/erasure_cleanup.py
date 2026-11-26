"""回收已注销账号的外部文件及向量；清单随 SQL 注销事务提交，服务重启可续跑。"""

import asyncio
import hashlib
import logging
import re
import shutil
from pathlib import Path
from typing import TypedDict, cast

from sqlalchemy import text

from app.infrastructure.database import Database
from app.modules.devices.service.device_service import DeviceService
from app.modules.files.service.file_service import FileService
from app.modules.knowledge.service.qdrant_service import QdrantService
from app.modules.runtime.service.runtime import RuntimeService

logger = logging.getLogger(__name__)


class CleanupManifest(TypedDict):
    objects: list[list[str]]
    parts: list[str]
    media: list[str]
    generations: list[str]
    devices: list[str]


def _child(directory: Path, name: str) -> Path:
    """只接受固定根下单级服务标识，防止历史损坏记录影响其他路径。"""
    if not re.fullmatch(r"[0-9A-Za-z_-]{1,128}", name):
        raise ValueError("invalid storage identifier")
    child = directory / name
    if (
        child.parent.resolve() != directory.absolute()
        or child.resolve().parent != directory.absolute()
    ):
        raise ValueError("invalid storage directory")
    return child


def _remove_tree(directory: Path, identifier: str) -> None:
    child = _child(directory, identifier)
    if child.is_symlink():
        child.unlink()
    elif child.is_dir():
        shutil.rmtree(child)


class ErasureCleanup:
    """每轮领取一项工作。幂等删除允许进程在任一步中断后重新执行。"""

    def __init__(
        self,
        database: Database,
        files: FileService,
        devices: DeviceService,
        qdrant: QdrantService,
        data: Path,
        runtime_root: Path,
    ):
        self.database, self.files, self.devices, self.qdrant = database, files, devices, qdrant
        self.data, self.runtime_root = data.absolute(), runtime_root.absolute()

    async def run(self, runtime: RuntimeService) -> None:
        while True:
            try:
                if await self.drain_one(runtime):
                    continue
            except Exception as error:
                logger.warning("account erasure cleanup will retry (%s)", type(error).__name__)
            await asyncio.sleep(5)

    async def drain_one(self, runtime: RuntimeService) -> bool:
        async with self.database.engine.begin() as db:
            row = (
                await db.execute(
                    text("""UPDATE account_erasure_jobs SET retry_at=now()+interval '1 minute'
                WHERE owner=(SELECT owner FROM account_erasure_jobs WHERE manifest IS NOT NULL AND retry_at<=now()
                    ORDER BY retry_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING owner, manifest""")
                )
            ).first()
        if row is None:
            return False
        uid, manifest = str(row.owner), cast(CleanupManifest, row.manifest)
        await runtime.stop_retired_owner(uid)
        await self.devices.terminals.retire_owner(uid)
        for device in manifest["devices"]:
            await self.devices.channel.disconnect(device)
        if not self.devices.operations.files.retire_owner(uid):
            return False
        # 清单阻止新的写入者。等候注销前已开始的媒体、索引及受管进程后再删磁盘。
        async with self.database.engine.begin() as db:
            idle = await db.scalar(
                text("""SELECT pg_try_advisory_xact_lock(hashtextextended('account-io:' || :uid,0))
                AND NOT EXISTS(SELECT 1 FROM runtime_execution_fences WHERE owner=:uid)"""),
                {"uid": uid},
            )
        if not idle:
            return False
        for storage, key in manifest["objects"]:
            if not re.fullmatch(r"objects/[a-f0-9]{32}", key):
                raise ValueError("invalid object key")
            await (await self.files.storage.get(storage)).remove(key)
        for generation in manifest["generations"]:
            if not re.fullmatch("[a-f0-9]{24}", generation):
                raise ValueError("invalid index generation")
            await self.qdrant.request(
                f"/collections/superdsh_knowledge_hybrid_{generation}/points/delete?wait=true",
                {"filter": {"must": [{"key": "ownerId", "match": {"value": uid}}]}},
                allowed=(404,),
            )
        await asyncio.to_thread(self._local, uid, manifest)
        async with self.database.engine.begin() as db:
            await db.execute(
                text("UPDATE account_erasure_jobs SET manifest=NULL WHERE owner=:uid"), {"uid": uid}
            )
        return True

    def _local(self, uid: str, manifest: CleanupManifest) -> None:
        for part in manifest["parts"]:
            _child(self.files.root.absolute() / "staging", part).unlink(missing_ok=True)
        for job in manifest["media"]:
            base = _child(self.data / "studio/media", job)
            for path in base.parent.glob(base.name + ".*"):
                if path.is_file() or path.is_symlink():
                    path.unlink(missing_ok=True)
        _remove_tree(self.data / "objects", uid)
        _remove_tree(self.runtime_root, hashlib.sha256(uid.encode()).hexdigest())

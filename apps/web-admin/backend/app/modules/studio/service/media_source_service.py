"""媒体库导出源的授权、实际时长与冻结文件清单；不依赖供应商任务冒充素材。"""

import asyncio
import os
import re
import shutil
import sys
import tempfile
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.asset_dao import AssetDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.vo.studio_vo import Document

if TYPE_CHECKING:
    from app.modules.studio.service.studio_service import StudioService


async def media_duration(path: Path) -> int:
    """使用部署已有的 FFmpeg 读取容器时长，超时与错误不以用户填值替代。"""
    executable = os.getenv("WEB_ADMIN_FFMPEG_EXECUTABLE") or shutil.which("ffmpeg")
    if not executable and sys.platform != "linux":
        executable = import_module("imageio_ffmpeg").get_ffmpeg_exe()
    if not executable:
        raise DomainError(503, "未找到 FFmpeg，无法检查媒体时长")
    process = await asyncio.create_subprocess_exec(
        executable,
        "-nostdin",
        "-hide_banner",
        "-protocol_whitelist",
        "file",
        "-i",
        str(path),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(15):
            _, output = await process.communicate()
        match = re.search(rb"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", output)
        if not match:
            raise DomainError(422, "媒体时长不可识别，请换用有效的视频或音频文件")
        hours, minutes, seconds = (float(value) for value in match.groups())
        duration = round((hours * 3600 + minutes * 60 + seconds) * 1000)
        if duration <= 0:
            raise DomainError(422, "媒体文件没有可播放内容")
        return duration
    except TimeoutError:
        raise DomainError(422, "媒体时长检查超时，请检查文件") from None
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


class MediaSourceService:
    def __init__(self, studio: "StudioService", root: Path) -> None:
        self.studio, self.root = studio, root

    async def metadata(
        self, account: Account, asset_id: str, project_id: str | None = None
    ) -> dict:
        """按需读取实际媒体时长并缓存事实；不修改素材版本、作品或生成任务。"""
        file_id = await self.studio.asset_file(account, project_id, asset_id)
        entry = await self.studio.files.entry(account, file_id)
        if not str(entry["mediaType"]).startswith(("video/", "audio/")):
            raise DomainError(422, "只有视频和音频需要读取时长")
        async with self.studio.database.sessions() as session:
            cached = await AssetDao(session).media_metadata([asset_id])
        if cached.get(asset_id):
            return {
                "assetId": asset_id,
                "durationMs": cached[asset_id],
                "mediaType": entry["mediaType"],
            }
        self.root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.root) as workspace:
            path = Path(workspace) / "source.media"
            content, _, _ = await self.studio.files.stream(account, file_id, None)
            with path.open("wb") as target:
                async for chunk in content:
                    await asyncio.to_thread(target.write, chunk)
            duration = await media_duration(path)
        async with self.studio.database.sessions.begin() as session:
            await AssetDao(session).save_media_metadata(asset_id, duration)
        return {"assetId": asset_id, "durationMs": duration, "mediaType": entry["mediaType"]}

    async def inspect_export(self, account: Account, project_id: str, revision: int) -> dict:
        """预检外部存储在事务外执行；提交时仍须重新验证同一工程修订。"""
        async with self.studio.database.sessions() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id)
            if project.revision != revision:
                raise DomainError(409, "工程已更新，请重新检查媒体")
            document = Document.model_validate((await dao.snapshot(project)).document)
            assets = {a.id: a.definition for a in await dao.assets(account.user_id, project_id)}
        sources = {
            identity: kind
            for shot in document.shots
            for identity, kind in [
                (shot.videoAssetId, "video"),
                *[(line.audioAssetId, "audio") for line in shot.lines],
            ]
            if identity
        }
        sources.update({effect.assetId: "audio" for effect in document.soundEffects})
        files: dict[str, str] = {}
        durations: dict[str, int] = {}
        if not sources:
            return {"files": files, "durations": durations}
        account.require("studio.assets.read")
        self.root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.root) as workspace:
            for index, (identity, kind) in enumerate(sources.items()):
                asset = assets.get(identity, {})
                if (
                    identity not in document.assets
                    or asset.get("kind")
                    not in ({"audio", "music"} if kind == "audio" else {"video"})
                    or not asset.get("fileId")
                ):
                    raise DomainError(422, "采用的媒体版本不可访问")
                file_id = str(asset["fileId"])
                content, metadata, _ = await self.studio.files.stream(account, file_id, None)
                if not str(metadata["mediaType"]).startswith(kind + "/"):
                    raise DomainError(422, "媒体文件类型与采用用途不一致")
                path = Path(workspace) / f"probe-{index}.media"
                with path.open("wb") as target:
                    async for chunk in content:
                        await asyncio.to_thread(target.write, chunk)
                durations[identity] = await media_duration(path)
                files[identity] = file_id
        for effect in document.soundEffects:
            if effect.trimStart >= durations[effect.assetId] or (
                effect.trimEnd is not None and effect.trimEnd > durations[effect.assetId]
            ):
                raise DomainError(422, "音效裁剪范围超过实际音频长度")
        async with self.studio.database.sessions.begin() as session:
            for identity, duration in durations.items():
                await AssetDao(session).save_media_metadata(identity, duration)
        return {"files": files, "durations": durations}

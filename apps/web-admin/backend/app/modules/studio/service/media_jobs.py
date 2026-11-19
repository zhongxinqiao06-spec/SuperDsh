"""媒体任务记录冻结的输入、模型修订与请求号；任务执行不占用 DSH 会话队列。"""

import asyncio
import base64
import hashlib
import json
import logging
import wave
from pathlib import Path
from typing import Any, cast

from sqlalchemy import select, text, update

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.configuration_service import ConfigurationService
from app.modules.studio.dao.production_dao import ProductionDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.vo.studio_vo import AssetInput, Batch, Document, identifier
from app.modules.studio.service.bailian_media import BailianMedia
from app.modules.studio.service.image_provider import ImageProvider
from app.modules.studio.service.job_lifecycle_service import JobLifecycleService
from app.modules.studio.service.media_source_service import MediaSourceService
from app.modules.studio.service.personal_generation_service import PersonalGenerationService
from app.modules.studio.service.preparation_media_service import PreparationMediaService
from app.modules.studio.service.production_service import ProductionService
from app.modules.studio.service.quick_service import QuickService
from app.modules.studio.service.series_access_service import assert_episode_editable
from app.modules.studio.service.studio_service import StudioService, job_view, validate_document
from app.modules.studio.service.timeline_renderer import TimelineRenderer, export_canvas

logger = logging.getLogger(__name__)


class MediaJobs:
    def __init__(
        self,
        studio: StudioService,
        models: ConfigurationService,
        identity: IdentityService,
        cipher: CredentialCipher,
        root: Path,
    ) -> None:
        self.studio, self.models, self.identity, self.cipher = studio, models, identity, cipher
        self.database, self.root = studio.database, root
        self.renderer = TimelineRenderer(root)
        self.sources = MediaSourceService(studio, root)
        self.runner: asyncio.Task[None] | None = None
        self.stopping = asyncio.Event()
        self.active: set[asyncio.Task[None]] = set()
        self.preparation = PreparationMediaService(self)
        self.production = ProductionService(self)
        self.personal = PersonalGenerationService(self)
        self.lifecycle = JobLifecycleService(self)
        self.quick = QuickService(self)

    @staticmethod
    def plan_hash(items: list[dict]) -> str:
        return hashlib.sha256(
            json.dumps(items, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()

    async def submit(
        self,
        account: Account,
        project_id: str,
        batch: Batch,
        *,
        preview: bool = False,
        approved_hash: str | None = None,
    ) -> list[dict]:
        account.require("products.entertainment")
        account.require("studio.projects.write")
        if not batch.export:
            return await self.production.legacy(account, project_id, batch, preview, approved_hash)
        fingerprint = hashlib.sha256(
            json.dumps(batch.model_dump(), sort_keys=True).encode()
        ).hexdigest()
        # 重试先返回冻结回执，不因后续编辑或媒体变更重复检查并提交。
        async with self.database.sessions() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id)
            prior = [j for j in await dao.jobs(project) if j.request_key == batch.requestKey]
            if prior:
                if prior[0].payload["fingerprint"] != fingerprint:
                    raise DomainError(409, "请求标识已用于其他生成方案")
                return [job_view(j) for j in prior]
        inspected = await self.sources.inspect_export(account, project_id, batch.revision)
        async with self.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            if project.lifecycle == "archived":
                raise DomainError(409, "请先恢复作品，再提交制作任务")
            jobs = await dao.jobs(project)
            prior = [j for j in jobs if j.request_key == batch.requestKey]
            if prior:
                if prior[0].payload["fingerprint"] != fingerprint:
                    raise DomainError(409, "请求标识已用于其他生成方案")
                return [job_view(j) for j in prior]
            if project.revision != batch.revision:
                raise DomainError(409, "工程已更新，请重新确认生成方案")
            await assert_episode_editable(session, account, project)
            document = Document.model_validate((await dao.snapshot(project)).document)
            asset_rows = await dao.assets(account.user_id, project.id)
            validate_document(document, asset_rows, jobs)
            assets = {a.id: a.definition for a in asset_rows}
            inputs: list[tuple[str, str, dict]] = []
            if batch.export:
                if batch.shots or batch.lines or not document.shots:
                    raise DomainError(422, "导出需要完整的分镜工程")
                aspect = (project.aspect_width or 16, project.aspect_height or 9)
                export_canvas(aspect)
                candidates = {j.id: j for j in jobs if j.state == "ready"}
                for shot in document.shots:
                    if not shot.videoAssetId and shot.candidate not in candidates:
                        raise DomainError(422, "请先采用镜头候选")
                    video_duration = (
                        inspected["durations"][shot.videoAssetId]
                        if shot.videoAssetId
                        else candidates[shot.candidate or ""].payload["duration"]
                    )
                    if (shot.trimEnd or shot.duration) > video_duration:
                        raise DomainError(422, "裁剪结束时间超过视频长度")
                    for line in shot.lines:
                        voice_duration = (
                            inspected["durations"].get(line.audioAssetId)
                            if line.audioAssetId
                            else candidates[line.audio].payload["duration"]
                            if line.audio in candidates
                            else None
                        )
                        if voice_duration is None or line.start + voice_duration > shot.duration:
                            raise DomainError(422, "请先采用配音并处理超出镜头时长的台词")
                inputs.append(
                    (
                        "export",
                        "timeline",
                        {
                            "document": document.model_dump(),
                            "mediaFiles": inspected["files"],
                            # 与工程版本一起冻结，后台继续编辑作品规格不会改变已提交的导出。
                            "aspect": {"width": aspect[0], "height": aspect[1]},
                            "music": assets[document.music].get("fileId")
                            if document.music
                            else None,
                        },
                    )
                )
            plan = [
                {
                    "kind": kind,
                    "target": subject,
                    "project": project.id,
                    "revision": project.revision,
                    "model": payload.get("binding"),
                    "seconds": payload.get("seconds"),
                    "characters": len(payload.get("text", "")),
                    "voice": payload.get("voice"),
                }
                for kind, subject, payload in inputs
            ]
            if preview:
                return plan
            if approved_hash and approved_hash != self.plan_hash(plan):
                raise DomainError(409, "工程或模型修订已改变，请重新确认生成用量")
            rows = [
                MediaJob(
                    id=identifier(),
                    project=project.id,
                    revision=project.revision,
                    kind=kind,
                    subject=subject,
                    request_key=batch.requestKey,
                    state="queued",
                    payload={**payload, "owner": account.user_id, "fingerprint": fingerprint},
                )
                for kind, subject, payload in inputs
            ]
            session.add_all(rows)
            await session.flush()
            return [job_view(row) for row in rows]

    def path(self, job: MediaJob) -> Path:
        return self.root / (
            job.id + (".wav" if job.kind == "speech" else ".png" if job.kind == "image" else ".mp4")
        )

    async def file(self, account: Account, project_id: str | None, job_id: str) -> tuple[Path, str]:
        account.require("products.entertainment")
        async with self.database.sessions() as session:
            job = await ProductionDao(session).job(job_id)
            await self.lifecycle.authorize(account, job)
            if (
                not job
                or job.project != project_id
                or job.state != "ready"
                or not self.path(job).is_file()
            ):
                raise DomainError(404, "媒体文件尚不可用")
            return (
                self.path(job),
                "audio/wav"
                if job.kind == "speech"
                else "image/png"
                if job.kind == "image"
                else "video/mp4",
            )

    async def collect(self, account: Account, project: str, job: str, name: str) -> dict:
        path, mime = await self.file(account, project, job)
        file = await self.studio.files.ingest_media(account, job, path, mime)
        return await self.studio.asset(
            account,
            AssetInput(
                kind="audio"
                if mime.startswith("audio/")
                else "image"
                if mime.startswith("image/")
                else "video",
                name=name,
                project=project,
                fileId=str(file["id"]),
            ),
            origin=job,
        )

    async def mark(self, job: MediaJob, state: str, **values: Any) -> None:
        """迟到的供应商回执仍持久化，但不能覆盖用户已请求的停止状态。"""
        async with self.database.sessions.begin() as session:
            row = await ProductionDao(session).job(job.id, lock=True)
            if row.cancel_requested:
                state = row.state if row.state == "cancelled" else "paused"
                values.pop("error", None)
            row.state = state
            for key, value in values.items():
                if key == "payload":
                    value = {**row.payload, **value}
                setattr(row, key, value)

    async def claim(self, job: MediaJob) -> bool:
        """发送前原子领取；在此之前取消的任务绝不触发付费请求。"""
        async with self.database.sessions.begin() as session:
            return await ProductionDao(session).claim(job.id, "queued")

    def save_submission(self, job: MediaJob, **values: str) -> None:
        """加密回执先原子落盘，数据库短暂断连后仍可核对同一次提交。"""
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / (job.id + ".submission.json")
        partial = target.with_suffix(".part")
        partial.write_text(self.cipher.seal(json.dumps(values), job.id), encoding="utf-8")
        partial.replace(target)

    async def recover(self, account: Account, project_id: str, job_id: str) -> dict:
        """恢复原回执的只读查询、下载或本地渲染，始终沿用已确认的工程修订。"""
        from app.modules.studio.entity.vo.production_vo import JobDecision

        async with self.database.sessions() as session:
            job = await ProductionDao(session).job(job_id)
            if job.project != project_id:
                raise DomainError(404, "制作任务不存在")
        return await self.lifecycle.decide(
            account,
            job_id,
            JobDecision(revision=job.revision, requestKey=identifier(), action="resume"),
        )

    async def process(self, job: MediaJob) -> None:
        # 只有已保存的远端任务号或下载回执允许恢复；中途失联不能重新发起付费请求。
        state = job.state
        try:
            account = await self.identity.get_account(job.payload["owner"])
            account.require("products.entertainment")
            if job.kind == "export":
                account.require("studio.projects.write")
                if job.payload.get("mediaFiles"):
                    account.require("studio.assets.read")
                if not await self.claim(job):
                    return
                music = (
                    (await self.studio.files.stream(account, job.payload["music"], None))[0]
                    if job.payload.get("music")
                    else None
                )
                media = {
                    asset: (await self.studio.files.stream(account, file_id, None))[0]
                    for asset, file_id in job.payload.get("mediaFiles", {}).items()
                }
                await self.renderer.render(
                    Document.model_validate(job.payload["document"]),
                    self.path(job),
                    music,
                    # 旧导出任务没有画幅快照，继续使用当时的横屏语义。
                    aspect=(
                        job.payload.get("aspect", {}).get("width", 16),
                        job.payload.get("aspect", {}).get("height", 9),
                    ),
                    media=media,
                )
            else:
                resolved = cast(
                    dict[str, Any],
                    await self.models.resolve(
                        account,
                        CapabilityBinding.model_validate(job.payload["binding"]),
                        "entertainment",
                    ),
                )
                if job.kind == "image":
                    image_provider = ImageProvider(self.models.transport, resolved)
                    receipt = self.root / (job.id + ".receipt.json")
                    if state == "queued":
                        image_references = []
                        for file_id in job.payload.get("images", []):
                            info = await self.studio.files.entry(account, file_id)
                            content, _ = await self.studio.files.read(account, file_id)
                            if len(content) > 20 * 1024 * 1024 or info["mediaType"] not in {
                                "image/png",
                                "image/jpeg",
                                "image/webp",
                            }:
                                raise DomainError(422, "参考图片格式或大小无效")
                            image_references.append(
                                "data:"
                                + str(info["mediaType"])
                                + ";base64,"
                                + base64.b64encode(content).decode()
                            )
                        if not await self.claim(job):
                            return
                        state = "submitting"
                        await image_provider.generate(
                            job.payload["prompt"], image_references, receipt
                        )
                        await self.mark(job, "downloading", provider_id="receipt")
                        return
                    await image_provider.result(receipt, self.path(job))
                    await self.models.resolve(
                        await self.identity.get_account(account.user_id),
                        CapabilityBinding.model_validate(job.payload["binding"]),
                        "entertainment",
                    )
                    await self.mark(job, "ready", error=None)
                    return
                provider = BailianMedia(
                    self.models.transport,
                    resolved["connection"]["baseUrl"],
                    resolved["apiKey"],
                    resolved["configuration"]["modelId"],
                )
                if state == "queued":
                    if job.kind == "speech" and job.payload["voice"] not in resolved[
                        "configuration"
                    ]["parameters"]["voices"].split(","):
                        raise DomainError(422, "音色不在所选配音模型的配置中")
                    references: list[str] = []
                    for file_id in job.payload.get("images", []):
                        info = await self.studio.files.entry(account, file_id)
                        if int(str(info["size"])) > 20 * 1024 * 1024 or info["mediaType"] not in {
                            "image/jpeg",
                            "image/png",
                            "image/webp",
                        }:
                            raise DomainError(422, "参考图格式或大小不符合供应商要求")
                        content, _ = await self.studio.files.read(account, file_id)
                        references.append(
                            "data:"
                            + str(info["mediaType"])
                            + ";base64,"
                            + base64.b64encode(content).decode("ascii")
                        )
                    if not await self.claim(job):
                        return
                    state = "submitting"
                    if job.kind == "video":
                        task = await provider.video(
                            job.payload["prompt"],
                            job.payload["seconds"],
                            references,
                            aspect=job.payload.get("aspect", "16:9"),
                            resolution=job.payload.get("resolution", "720P"),
                        )
                        self.save_submission(job, task=task)
                        await self.mark(job, "polling", provider_id=task)
                        return
                    url = await provider.speech(job.payload["text"], job.payload["voice"])
                    self.save_submission(job, url=url)
                    await self.mark(job, "downloading", provider_id=self.cipher.seal(url, job.id))
                    return
                if state == "polling":
                    status, url = await provider.status(job.provider_id or "")
                    if status in {"PENDING", "RUNNING"}:
                        await self.mark(job, "polling")
                        return
                    if status != "SUCCEEDED":
                        await self.mark(
                            job,
                            "unknown"
                            if status == "UNKNOWN"
                            else "cancelled"
                            if status in {"CANCELED", "CANCELLED"}
                            else "failed",
                            error="百炼任务状态 " + status,
                        )
                        return
                else:
                    url = self.cipher.open(job.provider_id or "", job.id)
                await provider.download(url, self.path(job))
                if job.kind == "speech":
                    with wave.open(str(self.path(job)), "rb") as audio:
                        # 流式 WAV 的头部可能保留占位长度，按真实 PCM 帧计算时长。
                        count = 0
                        while block := audio.readframes(16384):
                            count += len(block)
                        frame_bytes = audio.getnchannels() * audio.getsampwidth()
                        job.payload = {
                            **job.payload,
                            "duration": round(count * 1000 / frame_bytes / audio.getframerate()),
                        }
            await self.mark(job, "ready", payload=job.payload, error=None)
        except (DomainError, TimeoutError, OSError, ValueError, wave.Error) as exc:
            detail = exc.detail if isinstance(exc, DomainError) else "媒体处理失败"
            transient = not isinstance(exc, DomainError) or exc.status >= 500
            if (
                transient
                and state in {"polling", "downloading"}
                and job.payload.get("failures", 0) < 5
            ):
                await self.mark(
                    job,
                    state,
                    payload={**job.payload, "failures": job.payload.get("failures", 0) + 1},
                )
            else:
                await self.mark(
                    job,
                    "unknown" if transient and state == "submitting" else "failed",
                    error=detail,
                    payload={
                        **job.payload,
                        "recoveryState": state
                        if transient and state in {"polling", "downloading"}
                        else None,
                    },
                )

    async def run(self) -> None:
        """仅持有数据库会话锁的进程调度任务，外部调用不占用业务事务。"""
        while not self.stopping.is_set():
            try:
                async with self.database.engine.connect() as connection:
                    if await connection.scalar(
                        text("SELECT pg_try_advisory_lock(hashtext('studio-media-worker'))")
                    ):
                        try:
                            await connection.commit()
                            async with self.database.sessions.begin() as session:
                                await session.execute(
                                    update(MediaJob)
                                    .where(MediaJob.state == "submitting")
                                    .values(
                                        state="unknown", error="提交期间服务中断，请核对供应商记录"
                                    )
                                )
                            while not self.stopping.is_set():
                                await connection.execute(text("SELECT 1"))
                                await connection.commit()
                                async with self.database.sessions() as session:
                                    jobs = list(
                                        await session.scalars(
                                            select(MediaJob)
                                            .where(
                                                MediaJob.state.in_(
                                                    ["queued", "polling", "downloading"]
                                                )
                                            )
                                            .order_by(MediaJob.updated)
                                            .limit(4)
                                        )
                                    )
                                async with asyncio.TaskGroup() as group:
                                    for job in jobs:
                                        if self.stopping.is_set():
                                            break
                                        task = group.create_task(self.process(job))
                                        self.active.add(task)
                                        task.add_done_callback(self.active.discard)
                                await self.wait_for_stop(3)
                        finally:
                            await connection.execute(
                                text("SELECT pg_advisory_unlock(hashtext('studio-media-worker'))")
                            )
                            await connection.commit()
                    await self.wait_for_stop(3)
            except Exception:
                if self.stopping.is_set():
                    return
                logger.exception("媒体任务调度中断，即将重新连接")
                await self.wait_for_stop(5)

    async def wait_for_stop(self, delay: int) -> None:
        try:
            await asyncio.wait_for(self.stopping.wait(), delay)
        except TimeoutError:
            pass

    def start(self) -> None:
        if self.runner is None or self.runner.done():
            self.stopping.clear()
            self.runner = asyncio.create_task(self.run())

    async def close(self) -> None:
        # 允许查询提交及会话锁正常收尾。正在执行的供应商请求由持久回执接管恢复。
        self.stopping.set()
        for task in self.active:
            task.cancel()
        if self.runner:
            try:
                await asyncio.wait_for(asyncio.shield(self.runner), 10)
            except TimeoutError:
                self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
            self.runner = None

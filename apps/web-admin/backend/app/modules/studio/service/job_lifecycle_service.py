"""任务取消与受理核对：停止本地执行不冒充供应商已取消，核对绝不重新生成。"""

import json
from typing import TYPE_CHECKING, Any, cast

from app.infrastructure.errors import DomainError
from app.modules.billing.dao.usage_credit import finish_job
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.studio.dao.production_dao import ProductionDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.bo.production import ACTIVE, UNCERTAIN
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.do.production_do import JobAction
from app.modules.studio.entity.vo.production_vo import JobDecision
from app.modules.studio.entity.vo.studio_vo import identifier
from app.modules.studio.service.bailian_media import BailianMedia
from app.modules.studio.service.studio_service import job_view

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class JobLifecycleService:
    def __init__(self, media: "MediaJobs") -> None:
        self.media = media

    async def authorize(self, account: Account, job: MediaJob, *, write: bool = False) -> None:
        account.require("products.entertainment")
        account.require(
            "studio.projects.write"
            if job.project and write
            else "studio.projects.read"
            if job.project
            else "studio.assets.write"
            if write
            else "studio.assets.read"
        )
        async with self.media.database.sessions() as session:
            if job.project:
                await StudioDao(session).project(account.user_id, job.project)
            elif job.owner != account.user_id:
                raise DomainError(404, "制作任务不存在")
            else:
                await ProductionDao(session).entity(account.user_id, job.library_entity or "")

    async def history(self, account: Account, identity: str) -> list[dict]:
        async with self.media.database.sessions() as session:
            dao = ProductionDao(session)
            await self.authorize(account, await dao.job(identity))
            return [
                {"kind": row.kind, "detail": row.detail, "created": row.created_at.isoformat()}
                for row in await dao.actions(account.user_id, identity)
            ]

    async def provider(self, account: Account, job: MediaJob) -> BailianMedia:
        resolved = cast(
            dict[str, Any],
            await self.media.models.resolve(
                account, CapabilityBinding.model_validate(job.payload["binding"]), "entertainment"
            ),
        )
        return BailianMedia(
            self.media.models.transport,
            resolved["connection"]["baseUrl"],
            resolved["apiKey"],
            resolved["configuration"]["modelId"],
        )

    async def decide(self, account: Account, identity: str, body: JobDecision) -> dict:
        async with self.media.database.sessions() as session:
            job = await ProductionDao(session).job(identity)
        await self.authorize(account, job, write=True)
        fingerprint = content_hash({"job": identity, **body.model_dump()})
        # 核对与取消使用数据库已有回执。浏览器不能借供应商共用密钥认领别人的任务。
        receipt_id = job.provider_id
        receipt = self.media.root / (job.id + ".submission.json")
        if not receipt_id and receipt.is_file():
            saved = json.loads(self.media.cipher.open(receipt.read_text(encoding="utf-8"), job.id))
            receipt_id = (
                saved.get("task")
                if job.kind == "video"
                else self.media.cipher.seal(saved["url"], job.id)
                if saved.get("url")
                else None
            )
        if (
            not receipt_id
            and job.kind == "image"
            and (self.media.root / (job.id + ".receipt.json")).is_file()
        ):
            receipt_id = "receipt"
        if body.providerTask and (job.kind != "video" or body.providerTask != receipt_id):
            raise DomainError(422, "该任务号不属于本次提交的持久回执，不能认领")
        remote_status = None
        if body.action == "receipt":
            if not receipt_id:
                raise DomainError(
                    409, "尚无可验证回执，请在供应商控制台核对并记录结论；不会自动重发"
                )
            if job.kind == "video":
                remote_status, _ = await (await self.provider(account, job)).status(receipt_id)
        async with self.media.database.sessions.begin() as session:
            dao = ProductionDao(session)
            job = await dao.job(identity, lock=True)
            previous = await dao.action(account.user_id, body.requestKey)
            if previous:
                if previous.request_hash != fingerprint:
                    raise DomainError(409, "请求号已用于其它任务处置")
                return previous.result
            if body.revision != job.revision:
                raise DomainError(409, "任务版本不一致，请刷新")
            if body.action == "cancel":
                if job.state not in ACTIVE | UNCERTAIN:
                    raise DomainError(409, "任务已结束，无需取消")
                original = job.state
                job.cancel_requested = True
                job.state = "cancelled" if original == "queued" else "paused"
                job.error = (
                    "尚未提交，已取消"
                    if original == "queued"
                    else "已停止本地处理；远端可能仍在运行，可核对回执后恢复结果"
                )
                job.payload = {
                    **job.payload,
                    "recoveryState": original
                    if original in {"polling", "downloading"}
                    else job.payload.get("recoveryState"),
                }
            elif body.action in {"resume", "receipt"}:
                if job.payload.get("creditReleased"):
                    raise DomainError(409, "此任务的预留已释放，请重新预检生成")
                if job.state not in UNCERTAIN | {"failed"}:
                    raise DomainError(409, "任务状态已变化，请刷新")
                if remote_status in {"CANCELED", "CANCELLED"}:
                    job.state, job.error = "cancelled", "供应商已确认取消"
                elif remote_status == "FAILED":
                    job.state, job.error = "failed", "供应商已确认生成失败"
                    job.payload = {**job.payload, "recoveryState": None}
                elif remote_status == "UNKNOWN":
                    job.state, job.error = "unknown", "供应商仍无法确认受理状态"
                else:
                    if not receipt_id and job.kind != "export":
                        raise DomainError(409, "没有可恢复的原回执，不能重新生成")
                    job.provider_id = receipt_id
                    job.state = (
                        "queued"
                        if job.kind == "export"
                        else "polling"
                        if job.kind == "video"
                        else "downloading"
                    )
                    job.error = None
                    job.cancel_requested = False
                    job.payload = {**job.payload, "failures": 0, "recoveryState": None}
            else:
                if job.state not in UNCERTAIN or not body.reason.strip():
                    raise DomainError(422, "仅待核对任务可记录结论，请填写核对依据")
                if body.action == "unaccepted" and not body.acknowledged:
                    raise DomainError(422, "请确认已在供应商侧核对未受理")
                job.state = "unaccepted" if body.action == "unaccepted" else job.state
                job.error = (
                    "已记录人工核对结论；重新生成需明确确认重复执行风险"
                    if body.action == "unaccepted"
                    else job.error
                )
            if remote_status in {"RUNNING", "SUCCEEDED"}:
                job.payload = {**job.payload, "usageStarted": True}
            stopped_after_use = job.state == "paused" and job.payload.get("usageStarted")
            if job.payload.get("creditMetered") and (
                job.state in {"cancelled", "failed"} or stopped_after_use
            ):
                used = bool(job.payload.get("usageStarted"))
                charged = await finish_job(session, account.user_id, job.id, used=used)
                if not charged:
                    job.payload = {**job.payload, "creditReleased": True}
            await session.flush()
            await session.refresh(job)
            result = job_view(job)
            dao.add(
                JobAction(
                    id=identifier(),
                    owner=account.user_id,
                    job=identity,
                    request_key=body.requestKey,
                    request_hash=fingerprint,
                    kind=body.action,
                    detail={
                        "reason": body.reason,
                        "remoteStatus": remote_status,
                        "acknowledged": body.acknowledged,
                    },
                    result=result,
                )
            )
        if (
            body.action == "cancel"
            and job.kind == "video"
            and receipt_id
            and result["state"] == "paused"
        ):
            try:
                provider = await self.provider(account, job)
                remote_status, _ = await provider.status(receipt_id)
                if remote_status == "PENDING":
                    remote_status = await provider.cancel(receipt_id)
                async with self.media.database.sessions.begin() as session:
                    dao = ProductionDao(session)
                    current = await dao.job(identity, lock=True)
                    if (
                        current.cancel_requested
                        and current.state == "paused"
                        and remote_status in {"CANCELED", "CANCELLED"}
                    ):
                        current.state, current.error = "cancelled", "供应商已确认取消"
                        if current.payload.get("creditMetered"):
                            await finish_job(
                                session,
                                account.user_id,
                                current.id,
                                used=bool(current.payload.get("usageStarted")),
                            )
                    elif (
                        current.cancel_requested
                        and current.state == "paused"
                        and remote_status in {"RUNNING", "SUCCEEDED"}
                    ):
                        current.payload = {**current.payload, "usageStarted": True}
                        if current.payload.get("creditMetered"):
                            await finish_job(session, account.user_id, current.id, used=True)
                    record = await dao.action(account.user_id, body.requestKey)
                    await session.flush()
                    await session.refresh(current)
                    result = job_view(current)
                    if record:
                        record.detail = {**record.detail, "remoteStatus": remote_status}
                        record.result = result
            except (DomainError, OSError, TimeoutError):
                # 保留本地停止状态和回执，恢复时仅查询原任务，不重新生成。
                pass
        return result

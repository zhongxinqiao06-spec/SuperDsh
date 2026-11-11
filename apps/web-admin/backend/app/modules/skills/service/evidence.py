"""通用成果/证据服务，不按文档类型或助手名称分支。"""

import asyncio
import base64
import hashlib
from collections.abc import Awaitable, Callable
from pathlib import Path
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.entity.bo.evidence import Artifact, Evidence
from app.modules.skills.service.ports import RunRepository
from app.modules.skills.service.runs import SkillRunService, stable_hash


def file_hash(path: Path) -> str:
    """分块散列真实文件，避免大成果一次性加载进入 API 内存。"""
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


class EvidenceService:
    """只有可信执行回调登记，HTTP 不允许客户端伪造证据或任意磁盘路径。"""

    def __init__(
        self, repository: RunRepository, skills: SkillRunService, object_root: Path
    ) -> None:
        self.repository, self.skills, self.object_root = repository, skills, object_root.resolve()
        self.tool_receipt: Callable[[Account, str], Awaitable[dict[str, object]]] | None = None
        self.files: FileService | None = None

    def _path(self, account: Account, object_key: str) -> Path:
        owner_root = (self.object_root / account.user_id).resolve()
        candidate = (owner_root / object_key).resolve()
        if (
            not owner_root.is_relative_to(self.object_root)
            or not candidate.is_relative_to(owner_root)
            or not candidate.is_file()
            or candidate.stat().st_size > 256 * 1024 * 1024
        ):
            raise DomainError(422, "invalid managed artifact")
        return candidate

    async def register_artifact(
        self, account: Account, run_id: str, call_id: str, object_key: str, media_type: str
    ) -> Artifact:
        """已完成工具收据才能关联真实成果；登记摘要供下载前复核。"""
        run = await self.skills.read(account, run_id)
        path = self._path(account, object_key)
        digest = await asyncio.to_thread(file_hash, path)
        async with self.repository.transaction() as tx:
            await tx.lock(run_id)
            receipt = await tx.receipt(call_id)
            if (
                not receipt
                or receipt["runId"] != run_id
                or receipt["ownerId"] != account.user_id
                or receipt["state"] != "completed"
            ):
                raise DomainError(409, "artifact requires a verified tool receipt")
            artifact = Artifact(
                str(uuid4()),
                account.user_id,
                run.session_id,
                run_id,
                media_type,
                object_key,
                digest,
                {"callId": call_id},
            )
            if self.files:
                # 阶段工具与普通工具的成果均登记为会话附件，旧客户端下载同样走归属校验。
                file = await self.files.ingest_artifact(
                    account,
                    path.name,
                    await asyncio.to_thread(path.read_bytes),
                    media_type,
                    artifact.id,
                    run.session_id,
                )
                artifact.metadata_json.update({"fileId": file["id"], "filename": path.name})
            await tx.save_artifact(artifact)
            await tx.save_evidence(
                Evidence(
                    str(uuid4()),
                    account.user_id,
                    run_id,
                    "artifact",
                    artifact.id,
                    digest,
                    {"callId": call_id},
                )
            )
            return artifact

    async def record_receipt(self, account: Account, run_id: str, call_id: str) -> Evidence:
        """执行证据摘要取持久收据的真实结果，不接受调用者自行填通过状态。"""
        await self.skills.read(account, run_id)
        async with self.repository.transaction() as tx:
            receipt = await tx.receipt(call_id)
            if (
                not receipt
                or receipt["runId"] != run_id
                or receipt["ownerId"] != account.user_id
                or receipt["state"] != "completed"
            ):
                raise DomainError(409, "tool receipt is not verified")
            value = Evidence(
                str(uuid4()),
                account.user_id,
                run_id,
                "tool_receipt",
                call_id,
                stable_hash(receipt["result"]),
                {},
            )
            await tx.save_evidence(value)
            return value

    async def resolve_artifact(self, account: Account, artifact_id: str) -> tuple[Artifact, Path]:
        """下载前再次检查归属、资源状态与摘要，已被替换文件拒绝返回。"""
        async with self.repository.transaction() as tx:
            artifact = await tx.artifact(artifact_id)
        if artifact is None or artifact.owner_id != account.user_id:
            raise DomainError(404, "artifact not found")
        if artifact.run_id:
            await self.skills.read(account, artifact.run_id)
        else:
            if self.tool_receipt is None:
                raise DomainError(503, "tool receipt resolver is unavailable")
            receipt = await self.tool_receipt(
                account, str(artifact.metadata_json.get("receiptId", ""))
            )
            if (
                receipt.get("sessionId") != artifact.session_id
                or receipt.get("state") != "completed"
            ):
                raise DomainError(409, "artifact receipt is unavailable")
        path = self._path(account, artifact.object_key)
        if await asyncio.to_thread(file_hash, path) != artifact.sha256:
            raise DomainError(409, "artifact content changed")
        return artifact, path

    async def register_tool_artifact(
        self, account: Account, receipt_id: str, value: dict[str, object]
    ) -> Artifact:
        """普通工具成果引用真实持久收据，登记可重试且不伪造技能运行。"""
        if self.tool_receipt is None:
            raise DomainError(503, "tool receipt resolver is unavailable")
        receipt = await self.tool_receipt(account, receipt_id)
        if receipt.get("state") != "completed":
            raise DomainError(409, "artifact requires a completed receipt")
        key = str(value.get("objectKey", ""))
        path = self._path(account, key)
        digest = await asyncio.to_thread(file_hash, path)
        if value.get("sha256") != digest:
            raise DomainError(409, "artifact digest does not match execution")
        identifier = stable_hash([receipt_id, key])[:40]
        supplied = value.get("metadata", {})
        metadata = dict(supplied) if isinstance(supplied, dict) else {}
        metadata.update(
            {
                "receiptId": receipt_id,
                "callId": receipt.get("callId"),
                "filename": str(value.get("filename") or path.name),
                "structure": value.get("structure"),
                "bindingId": receipt.get("bindingId"),
            }
        )
        if self.files:
            entry = await self.files.ingest_artifact(
                account,
                str(metadata["filename"]),
                await asyncio.to_thread(path.read_bytes),
                str(value.get("mediaType", "application/octet-stream")),
                identifier,
                str(receipt["sessionId"]),
            )
            metadata["fileId"] = entry["id"]
        run_id = receipt.get("skillRunId")
        artifact = Artifact(
            identifier,
            account.user_id,
            str(receipt["sessionId"]),
            str(run_id) if run_id else None,
            str(value.get("mediaType", "application/octet-stream")),
            key,
            digest,
            metadata,
        )
        async with self.repository.transaction() as tx:
            await tx.lock("artifact:" + identifier)
            existing = await tx.artifact(identifier)
            if existing:
                if existing.sha256 != digest:
                    raise DomainError(409, "artifact publication conflict")
                if metadata.get("fileId") and not existing.metadata_json.get("fileId"):
                    existing.metadata_json = {
                        **existing.metadata_json,
                        "fileId": metadata["fileId"],
                    }
                    await tx.update_artifact(existing)
                return existing
            await tx.save_artifact(artifact)
            if artifact.run_id:
                await tx.save_evidence(
                    Evidence(
                        identifier,
                        account.user_id,
                        artifact.run_id,
                        "artifact",
                        identifier,
                        digest,
                        {"receiptId": receipt_id},
                    )
                )
        return artifact

    @staticmethod
    def view(artifact: Artifact) -> dict[str, object]:
        """目录响应仅含业务元数据，内部对象键和预览文件路径不离开服务端。"""
        metadata = {
            key: value
            for key, value in artifact.metadata_json.items()
            if key not in {"preview", "objectKey", "receiptId", "bindingId"}
        }
        return {
            **metadata,
            "id": artifact.id,
            "artifactId": artifact.id,
            "sessionId": artifact.session_id,
            "runId": artifact.run_id,
            "name": artifact.metadata_json.get("filename", artifact.id),
            "mediaType": artifact.media_type,
            "sha256": artifact.sha256,
            "downloadUrl": f"/api/sessions/{artifact.session_id}/agent-artifacts/{artifact.id}/download",
        }

    async def listing(self, account: Account, session_id: str) -> dict[str, object]:
        """上层已授权会话；成果本身仍必须通过绑定与真实对象校验。"""
        account.require("files.read")
        async with self.repository.transaction() as tx:
            values = await tx.artifacts(account.user_id, session_id)
        items = []
        for value in values:
            artifact, _ = await self.resolve_artifact(account, value.id)
            items.append(self.view(artifact))
        return {"artifacts": items, "items": items}

    async def preview(
        self, account: Account, session_id: str, artifact_id: str
    ) -> dict[str, object]:
        """只发布已经实际渲染且摘要一致的缓存；未渲染时明确返回不可用。"""
        artifact, path = await self.resolve_artifact(account, artifact_id)
        if artifact.session_id != session_id:
            raise DomainError(404, "artifact not found")
        media_type = artifact.media_type
        preview = artifact.metadata_json.get("preview")
        missing: object = []
        if media_type not in {"image/png", "image/jpeg", "application/pdf"}:
            pdf = preview.get("pdf") if isinstance(preview, dict) else None
            if not isinstance(pdf, dict):
                raise DomainError(
                    409, "artifact has no verified rendered preview", "artifact_preview_unavailable"
                )
            path = self._path(account, str(pdf.get("objectKey", "")))
            if await asyncio.to_thread(file_hash, path) != pdf.get("sha256"):
                raise DomainError(409, "artifact preview changed")
            media_type, missing = (
                "application/pdf",
                preview.get("missingFonts", []) if isinstance(preview, dict) else [],
            )
        if path.stat().st_size > 24 * 1024 * 1024:
            raise DomainError(413, "preview is too large; download the artifact")
        data = await asyncio.to_thread(path.read_bytes)
        return {
            "name": str(artifact.metadata_json.get("filename", path.name)),
            "mediaType": media_type,
            "contentBase64": base64.b64encode(data).decode(),
            "missingFonts": missing,
        }

"""可配置Office实现包入口；平台只通过通用工具契约调用本服务。"""

import asyncio
import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.service.knowledge_service import KnowledgeService
from app.modules.skills.service.evidence import EvidenceService
from app.modules.skills.service.runs import stable_hash
from app.workers.processes import ProcessWorkers
from toolkits.office.contracts import Artifact, record, text
from toolkits.office.multimodal_tool import MultimodalTool
from toolkits.office.preview import PreviewService
from toolkits.office.revisions import revise_structure
from toolkits.office.sources import Source, SourceResolver, json_value
from toolkits.office.worker import perform


class OfficeService:
    """工具专属方案和格式规则留在实现包，不能渗透平台会话核心。"""

    def __init__(
        self,
        sources: SourceResolver,
        evidence: EvidenceService,
        knowledge: KnowledgeService,
        workers: ProcessWorkers,
        previews: PreviewService,
        work_root: Path,
    ) -> None:
        self.sources, self.evidence, self.knowledge = sources, evidence, knowledge
        self.workers, self.previews, self.work_root = workers, previews, work_root.resolve()
        self.multimodal: MultimodalTool | None = None

    async def save_image(
        self, account: Account, session_id: str, operation_id: str, artifact: Artifact
    ) -> dict[str, object]:
        """相同供应商收据使用固定对象位置，保存重试不会复制文件或改变已保存内容。"""
        destination = self._destination(account, "model_" + stable_hash([session_id, operation_id]))
        await asyncio.to_thread(destination.mkdir, parents=True, exist_ok=True)
        path = destination / artifact.filename
        if path.resolve().parent != destination:
            raise DomainError(422, "图片成果文件名无效")
        digest = hashlib.sha256(artifact.content).hexdigest()

        def persist() -> None:
            if path.is_file():
                if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise DomainError(409, "图片操作的存储内容冲突")
                return
            temporary = destination / (str(uuid4()) + ".partial")
            try:
                temporary.write_bytes(artifact.content)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)

        await asyncio.to_thread(persist)
        metadata = {
            "objectKey": path.relative_to(self.evidence.object_root / account.user_id).as_posix(),
            "filename": artifact.filename,
            "mediaType": artifact.media_type,
            "sha256": digest,
            "metadata": artifact.metadata,
            "structure": artifact.structure,
        }
        return {
            "id": operation_id,
            "filename": artifact.filename,
            "sha256": digest,
            "pendingArtifact": metadata,
        }

    async def _plan(
        self,
        account: Account,
        session_id: str,
        arguments: dict[str, object],
        settings: dict[str, object],
    ) -> dict[str, object]:
        plan = json_value(arguments.get("planJson", arguments.get("plan")), "方案")
        previous_id = arguments.get("previousArtifactId")
        if previous_id:
            previous, _ = await self.evidence.resolve_artifact(account, str(previous_id))
            if previous.session_id != session_id:
                raise DomainError(403, "修订成果不属于当前会话")
            previous_structure = record(
                previous.metadata_json.get("plan", previous.metadata_json.get("structure")),
                "已有方案",
            )
            changes = arguments.get("revisionJson", arguments.get("revision"))
            if changes is not None:
                plan = revise_structure(
                    previous_structure, json_value(changes, "修订"), stable_hash(previous_structure)
                )
        result = record(plan, "方案")
        if not result.get("title") and settings.get("title"):
            result["title"] = settings["title"]
        if "slides" in result or "sections" in result:
            brand = record(result.get("brand", {}), "品牌")
            if "company" not in brand and settings.get("companyName"):
                brand["company"] = settings["companyName"]
            result["brand"] = brand
        if "designTheme" not in result and settings.get("designTheme"):
            result["designTheme"] = settings["designTheme"]
        return result

    async def _stage(self, sources: list[Source], directory: Path) -> list[dict[str, object]]:
        values: list[dict[str, object]] = []
        for index, source in enumerate(sources):
            path = directory / (str(index) + ".input")
            await asyncio.to_thread(path.write_bytes, source.file.content)
            values.append({**source.reference(), "path": str(path)})
        return values

    def _destination(self, account: Account, identifier: str) -> Path:
        owner = (self.evidence.object_root / account.user_id).resolve()
        destination = (owner / identifier).resolve()
        if owner.parent != self.evidence.object_root or destination.parent != owner:
            raise DomainError(422, "成果存储归属无效")
        return destination

    async def _quality(
        self, account: Account, artifact: Artifact, destination: Path, metadata: dict[str, object]
    ) -> None:
        if artifact.media_type == "image/png":
            return
        report = await self.previews.assess(artifact, destination)
        metadata["renderedQuality"] = report
        owner = self.evidence.object_root / account.user_id

        def preview_entry(path: Path, media_type: str) -> dict[str, object]:
            if not path.resolve().is_relative_to(destination.resolve()):
                raise DomainError(422, "预览路径越界")
            return {
                "objectKey": path.relative_to(owner).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "mediaType": media_type,
            }

        def preview_metadata() -> dict[str, object]:
            return {
                "pdf": preview_entry(destination / "preview.pdf", "application/pdf"),
                "pages": [
                    preview_entry(path, "image/png")
                    for path in sorted(
                        (destination / "pages").glob("*.png"),
                        key=lambda item: int(item.stem.split("-")[-1]),
                    )
                ],
                "missingFonts": report.get("missingFonts", []),
            }

        metadata["preview"] = await asyncio.to_thread(preview_metadata)

    async def execute(
        self,
        account: Account,
        implementation: str,
        arguments: dict[str, object],
        settings: dict[str, object],
        context: dict[str, object],
    ) -> dict[str, object]:
        """收费/写文件的执行只能依赖服务端持久确认，模型不能自报批准。"""
        binding_id, session_id = (
            text(context.get("bindingId"), "绑定", 200),
            text(context.get("sessionId"), "会话", 200),
        )
        phase = context.get("phase")
        if phase not in {"inspect", "prepare", "execute"}:
            raise DomainError(403, "工具调用缺少可信阶段")
        if implementation in {"image_generate", "vision_analyze"}:
            if self.multimodal is None:
                raise DomainError(503, "多模态工具尚未装配")
            return await self.multimodal.execute(
                account, implementation, arguments, settings, context
            )
        if implementation == "knowledge_search":
            if phase != "inspect":
                raise DomainError(422, "资料检索仅支持只读调用")
            result = await self.knowledge.search_binding(
                account, binding_id, text(arguments.get("query"), "检索问题", 2000)
            )
            return {"structuredContent": result}
        if implementation not in {
            "document_report",
            "spreadsheet_report",
            "presentation_report",
            "illustration_render",
        }:
            raise DomainError(422, "工具实现未注册")
        sources = await self.sources.resolve(account, binding_id, session_id, arguments)
        await asyncio.to_thread(self.work_root.mkdir, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="inputs-", dir=self.work_root) as root_name:
            root = Path(root_name)
            payload: dict[str, object] = {
                "implementation": implementation,
                "operation": phase,
                "inputRoot": str(root),
                "sources": await self._stage(sources, root),
                "allowValueExtraction": arguments.get("allowValueExtraction", False),
                "selections": json_value(arguments.get("sources"), "数据源选择"),
            }
            if phase == "inspect":
                return {"structuredContent": await self.workers.submit(perform, payload, 120)}
            plan = await self._plan(account, session_id, arguments, settings)
            payload.update({"operation": "prepare", "plan": plan})
            prepared = await self.workers.submit(perform, payload, 120)
            normalized = record(prepared["plan"], "规范方案")
            # 输入摘要、修订起点和冻结配置同时纳入确认栅栏；任何变化都要重新确认。
            plan_hash = stable_hash(
                {
                    "implementation": implementation,
                    "plan": normalized,
                    "sources": [source.reference() for source in sources],
                    "previousArtifactId": arguments.get("previousArtifactId"),
                    "settings": settings,
                }
            )
            if phase == "prepare":
                if implementation != "illustration_render":
                    await asyncio.to_thread(self.previews.command)
                return {
                    "structuredContent": {
                        "planHash": plan_hash,
                        "plan": normalized,
                        "sources": [source.reference() for source in sources],
                        "filename": prepared["filename"],
                        "structure": prepared["structure"],
                    }
                }
            if context.get("authorizedPlanHash") != plan_hash:
                raise DomainError(409, "方案或输入已变化，请重新确认", "plan_changed")
            destination = self._destination(account, str(uuid4()))
            await asyncio.to_thread(destination.mkdir, parents=True)
            try:
                payload.update(
                    {"operation": "execute", "plan": normalized, "outputRoot": str(destination)}
                )
                generated = await self.workers.submit(perform, payload, 180)
                filename = str(generated["filename"])
                path = destination / filename
                if path.resolve().parent != destination or not await asyncio.to_thread(
                    path.is_file
                ):
                    raise DomainError(502, "工具成果路径无效")
                metadata = record(generated["metadata"], "成果元数据")
                metadata.update(
                    {
                        "sources": [source.reference() for source in sources],
                        "plan": normalized,
                        "planHash": plan_hash,
                        "structureHash": stable_hash(normalized),
                        "previousArtifactId": arguments.get("previousArtifactId"),
                    }
                )
                artifact = Artifact(
                    filename,
                    await asyncio.to_thread(path.read_bytes),
                    str(generated["mediaType"]),
                    record(generated["structure"], "成果结构"),
                    metadata,
                )
                await self._quality(account, artifact, destination, metadata)
                quality = record(metadata.get("renderedQuality", {}), "质量检查")
                deliverable = quality.get("status") == "passed"
                # 保留失败预览便于用户修订，但工具不能把草稿宣告为可交付成果；
                # 此判断在工具自身执行，不受技能是否配置渲染检查的影响。
                metadata["deliverable"] = deliverable
                owner = self.evidence.object_root / account.user_id
                pending = {
                    "objectKey": path.relative_to(owner).as_posix(),
                    "filename": filename,
                    "mediaType": artifact.media_type,
                    "sha256": generated["sha256"],
                    "metadata": metadata,
                    "structure": generated["structure"],
                }
                await asyncio.to_thread(
                    (destination / "metadata.json").write_text,
                    json.dumps(pending, ensure_ascii=False),
                    encoding="utf-8",
                )
                return {
                    "structuredContent": {
                        "status": "generated" if deliverable else "draft",
                        "deliverable": deliverable,
                        "message": "成果已生成并通过确定性检查"
                        if deliverable
                        else "已保存草稿，质量检查未通过；请查看预览和问题清单后修订，不可作为已验收成果交付",
                        "name": filename,
                        "mediaType": artifact.media_type,
                        "planHash": plan_hash,
                        "quality": metadata.get("renderedQuality"),
                        "sources": metadata["sources"],
                    },
                    "_pendingArtifacts": [pending],
                }
            except BaseException:
                # 只回收当前调用刚创建的随机成果目录，已登记成果和旧修订不受影响。
                if (
                    destination.resolve().parent
                    != (self.evidence.object_root / account.user_id).resolve()
                ):
                    raise RuntimeError("拒绝越界清理成果") from None
                await asyncio.to_thread(shutil.rmtree, destination)
                raise

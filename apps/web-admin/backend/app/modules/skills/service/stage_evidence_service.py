"""阶段检查只读取可信执行收据和真实成果，不接受模型自评为通过。"""

import asyncio

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.service.knowledge_service import KnowledgeService
from app.modules.skills.entity.bo.runs import SkillRun
from app.modules.skills.service.binding_service import object_value
from app.modules.skills.service.evidence import EvidenceService, file_hash
from app.modules.skills.service.runs import stable_hash


class StageEvidenceService:
    """可配置检查独立于文档格式，扩展通过成果元数据提供可核对事实。"""

    def __init__(
        self, evidence: EvidenceService, knowledge: KnowledgeService | None = None
    ) -> None:
        self.evidence = evidence
        self.knowledge = knowledge

    async def validate(
        self, account: Account, run: SkillRun, stage: dict[str, object], output: dict[str, object]
    ) -> list[dict[str, object]]:
        checks = stage.get("checks", [])
        if not isinstance(checks, list):
            raise DomainError(422, "invalid stage checks")
        required = set(checks) - {"schema", "tool_receipt"}
        if not required:
            return []
        async with self.evidence.repository.transaction() as tx:
            artifacts = [
                item
                for item in await tx.artifacts(account.user_id, run.session_id)
                if item.run_id == run.id and item.metadata_json.get("skillRevision") == run.revision
            ]
        for artifact in artifacts:
            await self.evidence.resolve_artifact(account, artifact.id)
        results = []
        for validator in required:
            facts: object
            if validator == "sources":
                sources: list[dict[str, object]] = []
                for artifact in artifacts:
                    raw = artifact.metadata_json.get("sources", [])
                    if isinstance(raw, list):
                        sources.extend(source for source in raw if isinstance(source, dict))
                for records in object_value(run.outputs.get("calls")).values():
                    if isinstance(records, list):
                        for call in records:
                            result = object_value(object_value(call).get("result"))
                            structured = result.get("structuredContent", result)
                            raw_sources = (
                                structured
                                if isinstance(structured, list)
                                else object_value(structured).get("sources", [])
                            )
                            if isinstance(raw_sources, list):
                                sources.extend(
                                    source for source in raw_sources if isinstance(source, dict)
                                )
                if not sources or any(
                    not source.get("id", source.get("sourceId"))
                    or not isinstance(source.get("sha256"), str)
                    for source in sources
                ):
                    raise DomainError(409, "stage requires verified source evidence")
                for source in sources:
                    if isinstance(source.get("sourceId"), str):
                        if self.knowledge is None:
                            raise DomainError(503, "knowledge source verifier is unavailable")
                        current = await self.knowledge.verify_source(
                            account, run.binding_id, str(source["sourceId"])
                        )
                        if current.get("sha256") != source["sha256"]:
                            raise DomainError(409, "source evidence changed")
                facts = sources
            elif validator == "plan":
                if (
                    not run.approved_hash
                    or run.approved_hash != run.plan_hash
                    or not run.outputs.get("plan")
                ):
                    raise DomainError(409, "stage requires the current confirmed plan")
                facts = {"planHash": run.plan_hash, "revision": run.revision}
            elif validator in {"artifact", "rendered-quality"}:
                # 诊断草稿仍可读取下载，但不能充当交付证据；后续有效修订可替代它。
                deliverable = [
                    artifact
                    for artifact in artifacts
                    if artifact.metadata_json.get("deliverable") is not False
                ]
                if not deliverable:
                    raise DomainError(409, "stage requires a verified deliverable artifact")
                if validator == "rendered-quality":
                    documents = [
                        artifact
                        for artifact in deliverable
                        if not artifact.media_type.startswith("image/")
                    ]
                    if not documents:
                        raise DomainError(
                            409, "stage requires verified document rendering evidence"
                        )
                    for artifact in documents:
                        quality = object_value(artifact.metadata_json.get("renderedQuality"))
                        pdf = object_value(
                            object_value(artifact.metadata_json.get("preview")).get("pdf")
                        )
                        if quality.get("status") != "passed" or not pdf:
                            raise DomainError(
                                409, "stage requires verified document rendering quality"
                            )
                        path = self.evidence._path(account, str(pdf.get("objectKey", "")))
                        if await asyncio.to_thread(file_hash, path) != pdf.get("sha256"):
                            raise DomainError(409, "rendered evidence changed")
                facts = [
                    {
                        "id": artifact.id,
                        "sha256": artifact.sha256,
                        "quality": artifact.metadata_json.get("renderedQuality"),
                    }
                    for artifact in deliverable
                ]
            else:
                raise DomainError(422, "stage validator is unavailable")
            results.append(
                {
                    "validator": validator,
                    "version": run.version,
                    "passed": True,
                    "message": "已核对服务端持久证据",
                    "evidenceHash": stable_hash(facts),
                }
            )
        return results

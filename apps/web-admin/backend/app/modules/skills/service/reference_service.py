"""引用目录由真实检索收据恢复，访问时重新核验资料归属和原文摘要。"""

import re

from app.infrastructure.errors import DomainError
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.service.knowledge_service import KnowledgeService
from app.modules.skills.service.binding_service import object_value
from app.modules.skills.service.runs import stable_hash
from app.modules.skills.service.tool_execution_service import ToolExecutionService


def verify_answer(
    answer: dict[str, object] | None, sources: list[dict[str, object]]
) -> dict[str, object]:
    """只验证引用身份和逐字摘录，不把完整回答或模型推断宣称为已核实。"""
    base: dict[str, object] = {
        "status": "pending",
        "message": "等待完整回答后校验引用；下方仅展示授权原文。",
        "sourceIds": [],
        "checkedQuotes": 0,
        "issues": [],
    }
    if not answer or answer.get("status") not in {"done", "completed"}:
        return {**base, **({"messageId": answer["id"]} if answer else {})}
    content = object_value(answer.get("content"))
    text = str(content.get("text", content.get("content", "")))
    indexed = {str(item[key]): item for item in sources for key in ("id", "sourceId")}
    identifiers = list(dict.fromkeys(re.findall(r"\b(?:src|evidence)_[a-zA-Z0-9_-]+\b", text)))
    issues = [
        f"引用不存在、已失效或不属于当前会话：{identifier}"
        for identifier in identifiers
        if identifier not in indexed
    ]
    checked = 0
    if len(text) > 100000 or len(identifiers) > 100:
        issues.append("引用校验超出长度或数量限制")
    else:
        if re.search(r"</?cite\b", text, re.I):
            issues.append("引用包含不支持的 HTML 标记")
        for match in re.finditer(
            r'(?:“([^“”]+)”|「([^「」]+)」|"([^"]+)")\s*\[([a-zA-Z0-9_-]+)\]', text
        ):
            quote = match[1] or match[2] or match[3] or ""
            source = indexed.get(match[4])
            if (
                not source
                or not quote.strip()
                or len(quote) > 900
                or quote not in str(source.get("content", ""))
            ):
                issues.append(f"摘录与授权原文不一致：{match[4]}")
            else:
                checked += 1
    return {
        "status": "invalid" if issues else "references-checked" if identifiers else "no-citations",
        "message": "回答的引用校验未通过，请以授权原文为准。"
        if issues
        else "已核对来源编号及逐字摘录；改写、推断及整篇回答尚未核实。"
        if identifiers
        else "回答未提供可校验引用，不能视为已核实的结论。",
        "messageId": answer.get("id"),
        "sourceIds": [identifier for identifier in identifiers if identifier in indexed],
        "checkedQuotes": checked,
        "issues": list(dict.fromkeys(issues)),
    }


class ReferenceService:
    """撤权或资料变更立即撤销引用可信状态；浏览器不能登记任意原文。"""

    def __init__(
        self,
        tools: ToolExecutionService,
        conversations: ConversationService,
        knowledge: KnowledgeService | None,
    ) -> None:
        self.tools, self.conversations, self.knowledge = tools, conversations, knowledge

    async def sources(
        self,
        account: Account,
        session_id: str,
        identifier: str | None = None,
        quote: str | None = None,
    ) -> list[dict[str, object]]:
        account.require("files.read")
        if self.knowledge is None:
            raise DomainError(503, "knowledge evidence is unavailable")
        async with self.tools.repository.transaction() as dao:
            rows = await dao.list(account.user_id, session_id)
        found: dict[str, dict[str, object]] = {}
        for row in rows:
            if row.state != "completed":
                continue
            structured = (row.result or {}).get("structuredContent", row.result or {})
            raw_sources = (
                structured
                if isinstance(structured, list)
                else object_value(structured).get("sources", [])
            )
            if not isinstance(raw_sources, list):
                continue
            for raw in raw_sources:
                candidate = object_value(raw)
                source_id = candidate.get("sourceId")
                if not isinstance(source_id, str):
                    continue
                evidence_id = "evidence_" + stable_hash([row.id, source_id])[:32]
                if identifier and identifier not in {evidence_id, source_id}:
                    continue
                try:
                    await self.tools.resources.authorize_binding(account, row.binding_id)
                    current = await self.knowledge.verify_source(
                        account, row.binding_id, source_id, quote
                    )
                except DomainError as error:
                    if identifier or error.status not in {403, 404, 422}:
                        raise
                    continue
                if current.get("sha256") != candidate.get("sha256"):
                    if identifier:
                        raise DomainError(409, "source evidence has changed")
                    continue
                found[source_id] = {**current, "id": evidence_id}
        if identifier and not found:
            raise DomainError(404, "evidence not found in this session")
        return list(found.values())[:100]

    async def listing(self, account: Account, session_id: str) -> dict[str, object]:
        items = await self.sources(account, session_id)
        timeline = await self.conversations.timeline(account, session_id)
        rows = timeline.get("items", [])
        answer = (
            next(
                (
                    object_value(row)
                    for row in reversed(rows)
                    if object_value(row).get("type") == "message"
                    and object_value(row).get("role") == "assistant"
                ),
                None,
            )
            if isinstance(rows, list)
            else None
        )
        return {"items": items, "answerVerification": verify_answer(answer, items)}

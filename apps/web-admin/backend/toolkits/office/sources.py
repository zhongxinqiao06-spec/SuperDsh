"""工具输入解析只经已授权资产、当前会话附件与真实成果服务。"""

import asyncio
import json
from dataclasses import dataclass

from app.infrastructure.errors import DomainError
from app.modules.agents.service.asset_service import AssetService
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.service.evidence import EvidenceService
from toolkits.office.contracts import InputFile, record, sequence, text


def json_value(value: object, label: str) -> object:
    """JSON解析错误不回显用户内容；既接受旧字符串也接受结构化对象。"""
    if not isinstance(value, str):
        return value
    if len(value) > 200000:
        raise DomainError(413, label + "过大")
    try:
        return json.loads(value)
    except (ValueError, RecursionError) as error:
        raise DomainError(422, label + "必须是有效JSON，不要使用Markdown代码块") from error


@dataclass(frozen=True)
class Source:
    """输入摘要随确认方案冻结，执行时重新解析并比较。"""

    file: InputFile
    kind: str
    role: str

    def reference(self) -> dict[str, object]:
        """返回可公开来源标识，禁止传出服务器物理路径。"""
        return {
            "id": self.file.identifier,
            "kind": self.kind,
            "role": self.role,
            "name": self.file.filename,
            "sha256": self.file.sha256,
            "size": len(self.file.content),
        }


class SourceResolver:
    """在准备和执行两个边界都重新授权，不缓存用户权限或文件明文。"""

    def __init__(
        self, assets: AssetService, conversations: ConversationService, evidence: EvidenceService
    ) -> None:
        self.assets, self.conversations, self.evidence = assets, conversations, evidence

    async def resolve(
        self, account: Account, binding_id: str, session_id: str, arguments: dict[str, object]
    ) -> list[Source]:
        """显式输入不自动扩展为示例资料；同名附件必须消除歧义。"""
        await self.conversations.get_session(account, session_id)
        references = sequence(
            json_value(arguments.get("inputsJson", arguments.get("inputs", [])), "输入文件"),
            "输入文件",
            10,
        )
        if arguments.get("dataAssetId"):
            references.append({"assetId": arguments["dataAssetId"]})
        if arguments.get("templateAssetId"):
            references.append({"assetId": arguments["templateAssetId"], "role": "template"})
        if arguments.get("attachmentName"):
            references.append(
                {
                    "attachmentName": arguments["attachmentName"],
                    "attachmentHash": arguments.get("attachmentHash"),
                }
            )
        if len(references) > 10:
            raise DomainError(422, "每次最多选择10个输入文件")
        output: list[Source] = []
        seen: set[tuple[str, str]] = set()
        total = 0
        for raw in references:
            reference = record(
                raw,
                "文件引用",
                {"assetId", "artifactId", "attachmentName", "attachmentHash", "role"},
            )
            keys = [key for key in ("assetId", "artifactId", "attachmentName") if key in reference]
            role = reference.get("role", "input")
            if len(keys) != 1 or role not in {"input", "template", "knowledge", "image"}:
                raise DomainError(422, "每个文件只能指定一种来源与有效用途")
            key = keys[0]
            identifier = text(reference[key], "文件标识", 300)
            if key == "assetId":
                content, metadata = await self.assets.execution_content(
                    account, binding_id, identifier
                )
                name, kind = str(metadata["name"]), "asset"
            elif key == "artifactId":
                artifact, path = await self.evidence.resolve_artifact(account, identifier)
                if artifact.session_id != session_id:
                    raise DomainError(403, "成果不属于当前会话")
                content = await asyncio.to_thread(path.read_bytes)
                name, kind = str(artifact.metadata_json.get("filename", path.name)), "artifact"
            else:
                prefix = (
                    text(reference["attachmentHash"], "附件摘要", 64)
                    if reference.get("attachmentHash")
                    else None
                )
                content, metadata = await self.conversations.read_attachment(
                    account, session_id, identifier, prefix
                )
                identifier = str(metadata["id"])
                name, kind = str(metadata.get("name", reference[key])), "attachment"
            total += len(content)
            if len(content) > 10 * 1024 * 1024 or total > 40 * 1024 * 1024:
                raise DomainError(413, "单文件限10MiB，总输入限40MiB")
            if (identifier, str(role)) in seen:
                raise DomainError(422, "输入文件不能重复")
            seen.add((identifier, str(role)))
            output.append(Source(InputFile(name, content, identifier), kind, str(role)))
        if sum(source.role == "template" for source in output) > 1:
            raise DomainError(422, "每次只能选择一个模板")
        return output

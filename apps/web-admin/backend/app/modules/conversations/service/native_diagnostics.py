"""原生诊断兼容办公客户端；导演会话使用已绑定作品的正式会话接口。"""

from app.infrastructure.errors import DomainError
from app.modules.conversations.dao.conversation_dao import ConversationDao, ConversationRepository
from app.modules.identity.entity.bo.models import Account
from app.modules.runtime.entity.bo.values import Fields, Json


async def require_office_alias(
    dao: ConversationDao, owner: str, connector: str, identifier: str
) -> None:
    """未投影的旧引擎会话可继续导入；已有映射以持久化归属为准，不能通过别名重绑。"""
    for row in await dao.native_aliases(owner, connector, identifier):
        if (
            row.owner_id != owner
            or row.connector_id != connector
            or row.source.get("historyDeletedAt")
        ):
            raise DomainError(404, "session not found")
        if row.source.get("product", "office") != "office":
            raise DomainError(403, "请从对应作品打开导演会话")


class NativeDiagnostics:
    def __init__(self, repository: ConversationRepository) -> None:
        self.repository = repository

    async def authorize(self, account: Account, connector: str, identifier: str) -> None:
        account.require("products.office")
        async with self.repository.transaction() as dao:
            await require_office_alias(dao, account.user_id, connector, identifier)

    async def office_events(
        self, account: Account, connector: str, events: list[Fields]
    ) -> list[Fields]:
        """仅共用过引擎的账号需要拆分混合批次；保留游标使旧客户端正常翻页。"""
        account.require("products.office")
        async with self.repository.transaction() as dao:
            visible_ids = await dao.office_event_scope(account.user_id, connector)
        if visible_ids is None:
            return events
        result: list[Fields] = []
        for event in events:
            batch = event.get("batch")
            if not isinstance(batch, dict):
                continue
            scoped = {
                key: batch[key]
                for key in ("streamId", "batchSeq", "projectionVersion")
                if key in batch
            }
            operations = batch.get("operations")
            allowed: list[Json] = []
            for operation in operations if isinstance(operations, list) else []:
                if not isinstance(operation, dict):
                    continue
                kind = operation.get("kind")
                if kind == "notifications":
                    messages = operation.get("notifications")
                    if isinstance(messages, list):
                        messages = [
                            message
                            for message in messages
                            if isinstance(message, dict)
                            and self._session_event(message.get("params"), visible_ids)
                        ]
                        if messages:
                            allowed.append({"kind": kind, "notifications": messages})
                elif isinstance(kind, str) and kind.startswith(("snapshot.", "checkpoint.")):
                    if self._session_event(operation, visible_ids):
                        allowed.append(operation)
            scoped["operations"] = allowed
            result.append({"cursor": event.get("cursor"), "batch": scoped})
        return result

    @staticmethod
    def _session_event(value: Json, allowed: set[str]) -> bool:
        """多产品用户的原始批次只返回可归属的会话片段，整机库存走独立的授权快照。"""
        if not isinstance(value, dict):
            return False
        nested = value.get("session")
        identities = [value.get("sessionId"), value.get("externalSessionId")]
        if isinstance(nested, dict):
            identities.extend(
                [nested.get("id"), nested.get("sessionId"), nested.get("externalSessionId")]
            )
        keys = {key for key in identities if isinstance(key, str) and key}
        return bool(keys) and keys.issubset(allowed)

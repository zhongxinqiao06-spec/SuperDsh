"""会话终止、缺失诊断与历史删除；引擎是否停止始终依据真实运行状态。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import RuntimeFailure
from app.modules.conversations.service.projection_service import record
from app.modules.identity.entity.bo.models import Account

if TYPE_CHECKING:
    from app.modules.conversations.service.conversation_service import ConversationService


class SessionLifecycleService:
    """平台删除留身份墓碑，不删除独立文件或绕过 DSH 的执行队列。"""

    def __init__(self, conversations: "ConversationService") -> None:
        self.conversations = conversations

    async def interrupt(self, account: Account, identifier: str) -> dict[str, object]:
        """中断受理与实际停止分开；不存在的引擎会话改为可诊断异常而非永远 starting。"""
        row = await self.conversations.own(account, identifier, "sessions.run")
        try:
            result = record(
                await self.conversations.actions.command(account, identifier, "interrupt", {})
            )
            # cancel 是异步信号，读取实际状态并通过原投影发布，不能把 accepted 当成 idle。
            await self.conversations.actions.command(account, identifier, "state", {})
            await self.conversations.projection.sync(account)
            return result
        except RuntimeFailure as error:
            if error.code != "SESSION_NOT_FOUND":
                raise
            async with self.conversations.repository.transaction() as dao:
                await dao.lock(identifier)
                current = await dao.session(identifier)
                if not current or current.source.get("historyDeletedAt"):
                    raise DomainError(404, "session not found") from error
                if current.sequence != row.sequence:
                    raise DomainError(
                        409, "会话状态已变化，请同步后重试", "session_changed"
                    ) from error
                current.status = "error"
                current.state = {
                    **current.state,
                    "status": "error",
                    "statusReason": "session_source_missing",
                    "error": {
                        "code": "session_source_missing",
                        "message": "引擎中未找到此会话，可删除记录后新建；未自动重发原请求。",
                    },
                }
                await self.conversations.projection.emit(
                    dao, current, "runtime.state.updated", {"state": current.state}
                )
            # 这是缺失诊断，不虚构一次成功终止，也不释放结果未知的执行收据。
            return {"accepted": False, "missing": True, "sessionId": row.id}

    async def remove(self, account: Account, identifier: str) -> dict[str, object]:
        """拥有者才能删除，先核对运行状态，再在会话事务锁内拒绝并发新轮次。"""
        account.require("sessions.run")
        async with self.conversations.repository.transaction() as dao:
            prior = await dao.session(identifier)
            if not prior or prior.owner_id != account.user_id:
                raise DomainError(404, "session not found")
            if prior.source.get("historyDeletedAt"):
                return {"deleted": True}
        # 运行节点在线时必须复核，不能相信侧栏旧状态。明确不存在允许清理失败的创建记录。
        missing = False
        try:
            observed = record(
                await self.conversations.actions.command(account, identifier, "state", {})
            )
            state = record(observed.get("state", observed))
            if state.get("status") not in {"idle", "error"}:
                raise DomainError(
                    409, "请先终止任务，确认停止后再删除会话", "session_still_running"
                )
        except RuntimeFailure as error:
            if error.code != "SESSION_NOT_FOUND":
                raise
            missing = True
        async with self.conversations.repository.transaction() as dao:
            await dao.lock(identifier)
            row = await dao.session(identifier)
            if not row or row.owner_id != account.user_id:
                raise DomainError(404, "session not found")
            if row.source.get("historyDeletedAt"):
                return {"deleted": True}
            if not missing and row.status not in {"idle", "error"}:
                raise DomainError(409, "会话状态已变化，请先终止任务", "session_still_running")
            # 缺失诊断期间发生任何写入都拒绝删除，保留新提交与未知结果供同步核对。
            if missing and row.sequence != prior.sequence:
                raise DomainError(409, "会话状态已变化，请同步后重试", "session_changed")
            row.source = {**row.source, "historyDeletedAt": datetime.now(UTC).isoformat()}
            row.takeover = False
            row.agent_binding = None
            row.state = {}
            row.title = "已删除会话"
            row.updated_at = datetime.now(UTC)
            await dao.clear_history(identifier)
            await dao.save(row)
        return {"deleted": True}

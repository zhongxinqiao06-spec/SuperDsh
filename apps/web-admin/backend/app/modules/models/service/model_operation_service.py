"""收费模型操作的短事务幂等与密文收据，未知提交绝不自动重放。"""

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import ModelOperationRow
from app.modules.models.entity.vo.model_vo import CapabilityBinding


@dataclass(frozen=True)
class OperationClaim:
    """短租约token是结果发布栅栏，恢复只允许重用已保存供应商结果。"""

    identifier: str
    owner: str
    token: str
    state: str
    result: dict[str, object]
    receipt: dict[str, object] | None


class ModelOperationService:
    """不持有网络事务；每次状态写入都核验同一执行者和租约有效期。"""

    def __init__(self, database: Database, cipher: CredentialCipher) -> None:
        self.database, self.cipher = database, cipher

    async def claim(
        self,
        account: Account,
        session_id: str,
        key: str,
        binding: CapabilityBinding,
        request_hash: str,
    ) -> OperationClaim:
        """首次领取提交权；相同完成操作直接读结果，不同内容及未知状态拒绝重放。"""
        account.require("models.use")
        if not key or len(key) > 200 or not session_id or len(session_id) > 200:
            raise DomainError(422, "模型操作幂等标识或会话标识无效")
        identifier = (
            "operation_"
            + hashlib.sha256(
                json.dumps(
                    [account.user_id, session_id, key], ensure_ascii=False, separators=(",", ":")
                ).encode()
            ).hexdigest()
        )
        token, now = secrets.token_hex(24), datetime.now(UTC)
        async with self.database.sessions.begin() as session:
            await lock_transaction(session, "model-operation:" + identifier)
            dao = ModelDao(session)
            row = await dao.operation(identifier, account.user_id)
            receipt: dict[str, object] | None = None
            if row:
                if row.request_hash != request_hash:
                    raise DomainError(409, "执行标识已用于不同内容")
                if row.state == "completed":
                    return OperationClaim(
                        identifier, account.user_id, "", row.state, row.result, None
                    )
                if row.lease_until and row.lease_until > now:
                    raise DomainError(409, "模型操作正在处理，请稍后查询")
                if not row.receipt_ciphertext or row.state == "failed":
                    raise DomainError(
                        409,
                        "供应商操作状态需要核对，不会自动重复收费提交",
                        "provider_operation_pending",
                    )
                value = json.loads(self.cipher.open(row.receipt_ciphertext, identifier))
                if not isinstance(value, dict):
                    raise DomainError(500, "供应商收据格式无效")
                receipt = value
                row.state = "result-pending"
            else:
                row = ModelOperationRow(
                    id=identifier,
                    owner_id=account.user_id,
                    session_id=session_id,
                    configuration_id=binding.configurationId,
                    configuration_revision=binding.revision,
                    state="submitting",
                    request_hash=request_hash,
                    request_id=None,
                    usage={},
                    result={},
                    error=None,
                    updated_at=now,
                )
                dao.add(row)
            row.lease_token, row.lease_until = token, now + timedelta(seconds=15)
            row.updated_at = now
            return OperationClaim(
                identifier, account.user_id, token, row.state, dict(row.result), receipt
            )

    async def update(
        self,
        claim: OperationClaim,
        *,
        state: str | None = None,
        receipt: dict[str, object] | None = None,
        result: dict[str, object] | None = None,
        request_id: str | None = None,
        usage: dict[str, object] | None = None,
        error: str | None = None,
        release: bool = False,
    ) -> None:
        """更新是条件写，失去租约的迟到响应无法覆盖新执行者或已发布成果。"""
        async with self.database.sessions.begin() as session:
            await lock_transaction(session, "model-operation:" + claim.identifier)
            row = await ModelDao(session).operation(claim.identifier, claim.owner)
            now = datetime.now(UTC)
            if (
                not row
                or row.lease_token != claim.token
                or not row.lease_until
                or row.lease_until <= now
                or row.state == "completed"
            ):
                raise DomainError(409, "模型操作租约已失效")
            if state:
                row.state = state
            if receipt is not None:
                row.receipt_ciphertext = self.cipher.seal(
                    json.dumps(receipt, ensure_ascii=False, separators=(",", ":")), claim.identifier
                )
            if result is not None:
                row.result = result
            if request_id is not None:
                row.request_id = request_id[:200] or None
            if usage is not None:
                row.usage = usage
            if error is not None:
                row.error = error
            row.updated_at = now
            if state == "completed":
                row.receipt_ciphertext, row.error = None, None
            row.lease_token = None if release else claim.token
            row.lease_until = None if release else now + timedelta(seconds=15)

"""配对凭据短期加密保存，使用事务锁保证单次领取。"""

import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher, digest
from app.infrastructure.errors import DomainError
from app.infrastructure.input_validation import required_text
from app.modules.devices.dao.device_dao import DeviceRepository
from app.modules.devices.entity.do.models import DeviceRow, PairingRow
from app.modules.devices.entity.vo.device_dto import PairingClaim, PairingStart
from app.modules.identity.entity.bo.models import Account


def make_device(
    owner: str, name: str, kind: str, executor: str, os: str | None
) -> tuple[DeviceRow, str]:
    """仅创建远程设备，server-agent 身份始终由平台派生。"""
    if kind == "server-agent" or executor == "server-agent":
        raise DomainError(422, "server Agent identity is managed by the platform")
    now, token = datetime.now(UTC), "agt_" + secrets.token_urlsafe(32)
    return DeviceRow(
        id="conn_" + uuid4().hex,
        owner_id=owner,
        name=name.strip(),
        connector_kind=kind,
        executor_kind=executor,
        device_os=os,
        token_hash=digest(token),
        token_prefix=token[:12],
        revoked=False,
        preferences={},
        metadata_json={},
        created_at=now,
        updated_at=now,
    ), token


class PairingService:
    """配对流程不启动执行引擎，领取后才建立设备所有权。"""

    def __init__(self, repository: DeviceRepository, cipher: CredentialCipher) -> None:
        self.repository, self.cipher = repository, cipher

    async def start(self, value: PairingStart) -> dict[str, object]:
        """服务地址只接受 HTTP(S)，拒绝带凭据的连接配置。"""
        if value.serverUrl:
            parsed = urlsplit(value.serverUrl)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.fragment
                or parsed.query
            ):
                raise DomainError(422, "invalid server URL")
        now = datetime.now(UTC)
        async with self.repository.transaction() as dao:
            await dao.lock("pairing-codes")
            for _ in range(10):
                code = f"{secrets.randbelow(1_000_000):06}"
                existing = await dao.pairing_code(digest(code))
                if not existing or existing.expires_at < now:
                    break
            else:
                raise DomainError(503, "pairing service busy")
            row = PairingRow(
                id="pair_" + secrets.token_urlsafe(32),
                code_hash=digest(code),
                state="pending",
                server_url=value.serverUrl,
                expires_at=now + timedelta(seconds=value.ttlSeconds),
            )
            await dao.save(row)
        return {
            "pairingId": row.id,
            "code": code,
            "expiresAt": row.expires_at.isoformat(),
            "serverTime": now.isoformat(),
        }

    async def claim(self, account: Account, value: PairingClaim) -> DeviceRow:
        """认领与保存设备凭据在同一短事务内提交，重复认领不会更换所有者。"""
        account.require("devices.manage")
        async with self.repository.transaction() as dao:
            await dao.lock("pairing-codes")
            row = await dao.pairing_code(digest(value.code))
            if not row or row.expires_at <= datetime.now(UTC):
                raise DomainError(404, "pairing code not found")
            if row.state != "pending":
                raise DomainError(409, "pairing already claimed")
            if value.connectorId:
                device = await dao.device(value.connectorId)
                # 先隐藏不存在或不属于当前账号的设备，再区分凭据缺失与凭据失效。
                if not device or device.owner_id != account.user_id or device.revoked:
                    raise DomainError(404, "connector not found")
                if device.blocked_at:
                    raise DomainError(403, "invalid existing connector credentials")
                token = required_text(value.connectorToken, "connectorToken")
                if digest(token) != device.token_hash:
                    raise DomainError(401, "invalid connector token")
            else:
                device, token = make_device(
                    account.user_id,
                    value.name,
                    value.connectorKind,
                    value.executorKind,
                    value.deviceOs,
                )
                await dao.save(device)
            row.state, row.connector_id = "claimed", device.id
            row.encrypted_token = self.cipher.seal(token, row.id)
            await dao.save(row)
            return device

    async def poll(self, identifier: str) -> dict[str, object]:
        """只有随机 pairingId 可消费密文，消费提交后再次请求返回冲突。"""
        async with self.repository.transaction() as dao:
            await dao.lock("pairing:" + identifier)
            row = await dao.pairing(identifier)
            if not row:
                raise DomainError(404, "pairing id not found")
            now = datetime.now(UTC)
            if row.expires_at <= datetime.now(UTC):
                row.encrypted_token = None
                row.state = "expired"
                await dao.save(row)
                return {"status": "expired", "serverTime": now.isoformat()}
            if row.consumed_at:
                raise DomainError(409, "pairing already consumed")
            if row.state == "pending":
                return {"status": "pending", "serverTime": now.isoformat()}
            if not row.encrypted_token:
                raise DomainError(409, "pairing unavailable")
            token = self.cipher.open(row.encrypted_token, row.id)
            row.encrypted_token, row.consumed_at = None, datetime.now(UTC)
            await dao.save(row)
            return {
                "status": "claimed",
                "serverTime": now.isoformat(),
                "config": {
                    "serverUrl": row.server_url,
                    "connectorId": row.connector_id,
                    "connectorToken": token,
                },
            }

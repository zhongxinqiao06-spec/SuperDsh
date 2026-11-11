"""平台配置、公告与服务诊断；凭据加密、乐观版本及权限由用例统一控制。"""

import json
import re
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.service.identity import IdentityService
from app.modules.management.dao.system_dao import SqlManagementRepository
from app.modules.management.entity.do.models import SettingRow
from app.modules.management.entity.vo.system_vo import AnnouncementInput, ServiceSettingsInput


def object_value(value: object) -> dict[str, object]:
    """配置对象显式收窄，数据库异常数据不能被隐式解包。"""
    return dict(value) if isinstance(value, dict) else {}


class SystemManagement:
    """公开配置服务只返回脱敏 DTO，内部认证流程通过独立方法获取必要秘密。"""

    def __init__(
        self,
        repository: SqlManagementRepository,
        identity: IdentityService,
        cipher: CredentialCipher,
        public_origin: str,
        database_url: str,
        build: dict[str, object],
    ) -> None:
        self.repository, self.identity, self.cipher = repository, identity, cipher
        self.public_origin, self.database_url, self.build = public_origin, database_url, build
        self.allowed_origins: tuple[str, ...] = (public_origin,)
        self.started = datetime.now(UTC)
        self.instance_id = str(uuid4())
        self.facts_provider: (
            Callable[[Account, str, str, str], Awaitable[dict[str, object]]] | None
        ) = None

    async def current_actor(self, account: Account, permission: str) -> None:
        """写事务拿身份锁后复验当前会话与权限，阻止排队中的撤权请求继续写入。"""
        current = await self.identity.authenticate(
            self.identity.security.issue(account.user_id, account.session_id, account.auth_version)
        )
        current.require(permission)

    async def read_value(
        self, key: str, default: dict[str, object]
    ) -> tuple[dict[str, object], int]:
        """跨控制器复用持久配置读取，不创建启动默认记录覆盖用户设置。"""
        async with self.repository.sessions() as session:
            row = await self.repository.setting(session, key)
            return (deepcopy(row.value), row.revision) if row else (deepcopy(default), 0)

    async def internal_settings(self) -> dict[str, object]:
        """仅给身份/邮件公开服务使用的解密配置，不能由 controller 直接返回。"""
        async with self.repository.sessions() as session:
            row = await self.repository.setting(session, "service")
            value = (
                deepcopy(row.value)
                if row
                else {
                    "registrationOpen": False,
                    "oauthRegistrationOpen": False,
                    "oauth": {},
                    "email": {"enabled": False, "fromAddress": ""},
                }
            )
            secrets = (
                json.loads(self.cipher.open(row.secret, "platform-settings:service"))
                if row and row.secret
                else {}
            )
            for field, secret_name in (("email", "apiKey"), ("oauth", "clientSecret")):
                group = object_value(value.get(field))
                group[secret_name] = secrets.get(field, "")
                value[field] = group
            value["revision"] = row.revision if row else 0
            return value

    async def settings(self, account: Account | None = None) -> dict[str, object]:
        """管理配置保持旧字段，秘密仅返回是否已经配置。"""
        if account:
            account.require("settings.manage")
        value = await self.internal_settings()
        for name, key in (("email", "apiKey"), ("oauth", "clientSecret")):
            group = object_value(value.get(name))
            configured = bool(group.pop(key, ""))
            if name == "oauth" and not group and not configured:
                value[name] = None
                continue
            group[key + "Configured"] = configured
            value[name] = group
        return value

    async def update_settings(
        self, account: Account, body: ServiceSettingsInput
    ) -> dict[str, object]:
        """空密钥表示保留；清空是显式互斥操作，失败不会部分提交其他设置。"""
        account.require("settings.manage")
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            await self.current_actor(account, "settings.manage")
            row = await self.repository.setting(session, "service")
            revision = row.revision if row else 0
            if body.revision is not None and body.revision != revision:
                raise DomainError(409, "settings changed; reload before saving")
            value = (
                deepcopy(row.value)
                if row
                else {
                    "registrationOpen": False,
                    "oauthRegistrationOpen": False,
                    "oauth": {},
                    "email": {"enabled": False, "fromAddress": ""},
                }
            )
            secrets = (
                json.loads(self.cipher.open(row.secret, "platform-settings:service"))
                if row and row.secret
                else {}
            )
            patch = body.model_dump(exclude_unset=True, exclude_none=True)
            for key in ("registrationOpen", "oauthRegistrationOpen"):
                if key in patch:
                    value[key] = patch[key]
            for field, secret_name, clear in (
                ("email", "apiKey", "clearApiKey"),
                ("oauth", "clientSecret", "clearClientSecret"),
            ):
                if field not in patch:
                    continue
                incoming = dict(patch[field])
                supplied = incoming.pop(secret_name, "")
                if field == "email" and isinstance(supplied, str):
                    supplied = supplied.strip()
                    if supplied and not re.fullmatch(r"[\x21-\x7e]+", supplied):
                        raise DomainError(422, "Enter a valid Resend API key.")
                clearing = incoming.pop(clear, False)
                if clearing and supplied:
                    raise DomainError(422, "cannot replace and clear a credential together")
                if clearing:
                    secrets[field] = ""
                elif supplied:
                    secrets[field] = supplied
                defaults = (
                    {"enabled": False, "provider": "oidc", "label": "OAuth"}
                    if field == "oauth"
                    else {}
                )
                group = {**defaults, **object_value(value.get(field)), **incoming}
                if field == "email":
                    sender = str(group.get("fromAddress", "")).strip()
                    if sender and (
                        "\n" in sender
                        or "\r" in sender
                        or not re.search(r"(?:^|<)[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$", sender)
                    ):
                        raise DomainError(422, "Enter a valid sender email address.")
                    if "fromAddress" in group:
                        group["fromAddress"] = sender
                    if group.get("enabled") and (not sender or not secrets.get(field)):
                        raise DomainError(
                            422,
                            "A Resend API key and sender address are required to enable verification.",
                        )
                if (
                    field == "oauth"
                    and group.get("enabled")
                    and not all(
                        group.get(key)
                        for key in ("clientId", "authorizeUrl", "tokenUrl", "userInfoUrl")
                    )
                ):
                    raise DomainError(422, "OAuth URLs and client ID are required")
                value[field] = group
            await self.repository.save_setting(
                session,
                SettingRow(
                    key="service",
                    value=value,
                    secret=self.cipher.seal(json.dumps(secrets), "platform-settings:service"),
                    revision=revision + 1,
                    updated_at=datetime.now(UTC),
                ),
            )
        await self.identity.audit(
            account.user_id, "settings.updated", "global", {"fields": list(patch.keys())}
        )
        return await self.settings(account)

    async def announcement(self, account: Account | None = None) -> dict[str, object]:
        value, revision = await self.read_value(
            "announcement", {"enabled": False, "markdown": "", "publishedAt": None}
        )
        if account:
            account.require("settings.manage")
            return {**value, "revision": revision}
        return {
            "announcement": {"markdown": value["markdown"], "publishedAt": value["publishedAt"]}
            if value.get("enabled") and value.get("publishedAt")
            else None
        }

    async def publish(self, account: Account, body: AnnouncementInput) -> dict[str, object]:
        """内容未变不更换发布标识；新发布使用单调时间使已读门禁重新出现。"""
        account.require("settings.manage")
        async with self.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            await self.current_actor(account, "settings.manage")
            row = await self.repository.setting(session, "announcement")
            previous = row.value if row else {}
            if body.revision is not None and body.revision != (row.revision if row else 0):
                raise DomainError(409, "announcement changed; reload before saving")
            published = previous.get("publishedAt")
            if body.enabled and (
                not previous.get("enabled") or body.markdown != previous.get("markdown")
            ):
                now = datetime.now(UTC)
                if published:
                    now = max(
                        now, datetime.fromisoformat(str(published)) + timedelta(milliseconds=1)
                    )
                published = now.isoformat()
            value = {"enabled": body.enabled, "markdown": body.markdown, "publishedAt": published}
            await self.repository.save_setting(
                session,
                SettingRow(
                    key="announcement",
                    value=value,
                    secret=None,
                    revision=(row.revision if row else 0) + 1,
                    updated_at=datetime.now(UTC),
                ),
            )
        await self.identity.audit(account.user_id, "announcement.updated", "global", {})
        return await self.announcement(account)

    def service_information(self, account: Account) -> dict[str, object]:
        """运行诊断不返回数据库密码、绝对数据路径或运行时秘密。"""
        account.require("settings.manage")
        database = urlsplit(self.database_url)
        return {
            "endpoint": self.public_origin,
            "version": self.build["version"],
            "database": "PostgreSQL",
            "databasePath": f"{database.hostname}:{database.port or 5432}{database.path}",
            "coordination": "redis",
            "instanceId": self.instance_id,
            "startedAt": self.started.isoformat(),
            "uptimeSeconds": int((datetime.now(UTC) - self.started).total_seconds()),
            "serverTime": datetime.now(UTC).isoformat(),
        }

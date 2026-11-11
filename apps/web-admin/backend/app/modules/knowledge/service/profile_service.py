"""Embedding 配置切换，全部资料新代际建立成功后才原子替换活动配置。"""

import hashlib
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.agents.service.asset_service import AssetService
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.dao.knowledge_dao import KnowledgeDao
from app.modules.knowledge.entity.do.knowledge_do import KnowledgeProfileRow
from app.modules.knowledge.entity.vo.knowledge_vo import EmbeddingInput
from app.modules.knowledge.service.embedding_service import LOCAL_PROFILE, EmbeddingService
from app.modules.knowledge.service.index_service import KnowledgeIndexService
from app.modules.models.service.model_service import Audit
from app.modules.models.service.provider_transport import ProviderTransport


def external_profile(body: EmbeddingInput) -> dict[str, object]:
    """配置启动默认值和手动切换使用同一模型标识，索引代际可复用。"""
    if not body.model.strip() or not body.revision.strip() or not body.baseUrl:
        raise DomainError(422, "外部 Embedding 需要地址、模型与模型修订")
    identity = f"{body.baseUrl}:{body.model}:{body.revision}:{body.dimensions}"
    return {
        "id": "external_" + hashlib.sha256(identity.encode()).hexdigest()[:20],
        "kind": body.kind,
        "model": body.model.strip(),
        "revision": body.revision.strip(),
        "dimensions": body.dimensions,
        "baseUrl": body.baseUrl,
    }


class KnowledgeProfileService:
    """配置持久修订由数据库比较交换，无进程缓存导致的跨实例旧配置。"""

    def __init__(
        self,
        database: Database,
        cipher: CredentialCipher,
        assets: AssetService,
        index: KnowledgeIndexService,
        directory: Path,
        transport: ProviderTransport,
        trusted_origins: str = "",
        audit: Audit | None = None,
        account_lookup: Callable[[str], Awaitable[Account]] | None = None,
    ) -> None:
        self.database, self.cipher, self.assets, self.index = database, cipher, assets, index
        self.directory, self.transport, self.trusted_origins = directory, transport, trusted_origins
        self.audit, self.account_lookup = audit, account_lookup

    def build(self, profile: dict[str, object], credential: str | None) -> EmbeddingService:
        """密钥只进入服务器编码客户端，公开 profile 不包含明文或密文。"""
        key = self.cipher.open(credential, "knowledge-embedding") if credential else ""
        return EmbeddingService(profile, self.directory, self.transport, key, self.trusted_origins)

    async def initialize_default(self, values: dict[str, object]) -> None:
        """只初始化没有索引和活动配置的库，保留管理员已选择的模型。"""
        body = EmbeddingInput.model_validate({**values, "kind": "openai-compatible", "version": 0})
        profile = external_profile(body)
        self.build(profile, None).authorize_origin()
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "knowledge-embedding-profile")
            dao = KnowledgeDao(session)
            if await dao.profile() is None and not await dao.has_documents():
                dao.add(KnowledgeProfileRow(id="active", profile=profile, version=1))

    async def current(self) -> EmbeddingService:
        """每次用例读取活动修订，长任务持有自己的不可变配置对象。"""
        async with self.database.sessions() as session:
            row = await KnowledgeDao(session).profile()
            return self.build(
                row.profile if row else LOCAL_PROFILE, row.credential if row else None
            )

    async def view(self, account: Account) -> dict[str, object]:
        """读取模型设置需要平台模型管理权限。"""
        account.require("models.manage")
        async with self.database.sessions() as session:
            row = await KnowledgeDao(session).profile()
            return {
                "version": row.version if row else 0,
                "profile": {
                    **(row.profile if row else LOCAL_PROFILE),
                    "apiKeyConfigured": bool(row and row.credential),
                },
                "localDefault": LOCAL_PROFILE,
            }

    async def _authorize(self, account: Account) -> Account:
        current = await self.account_lookup(account.user_id) if self.account_lookup else account
        current.require("models.manage")
        current.require("agents.manage")
        return current

    async def save(self, account: Account, body: EmbeddingInput) -> dict[str, object]:
        """任何依赖失败保留原活动配置；并发保存后到者返回冲突。"""
        account = await self._authorize(account)
        async with self.database.sessions() as session:
            old = await KnowledgeDao(session).profile()
            if body.version != (old.version if old else 0):
                raise DomainError(409, "Embedding 设置已更新，请刷新后重试")
            old_profile, old_credential = (
                old.profile if old else LOCAL_PROFILE,
                old.credential if old else None,
            )
        credential: str | None = None
        profile = dict(LOCAL_PROFILE)
        if body.kind != "local":
            profile = external_profile(body)
            key = body.apiKey.get_secret_value() if body.apiKey else ""
            if len(key) > 8192 or key and body.clearApiKey:
                raise DomainError(422, "密钥长度或清空选项无效")
            before, after = urlsplit(str(old_profile.get("baseUrl", ""))), urlsplit(body.baseUrl)
            if before.scheme == after.scheme and before.netloc == after.netloc:
                credential = old_credential
            if key:
                credential = self.cipher.seal(key, "knowledge-embedding")
            elif body.clearApiKey:
                credential = None
        candidate = self.build(profile, credential)
        candidate.authorize_origin()
        await candidate.ready()
        documents = await self.assets.documents_for_reindex(account)
        for owner, asset in documents:
            await self._authorize(account)
            await self.index.index(owner, [asset], candidate)
        await self._authorize(account)
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(session, "knowledge-embedding-profile")
            dao = KnowledgeDao(session)
            row = await dao.profile()
            if body.version != (row.version if row else 0):
                raise DomainError(409, "另一个管理员已更新 Embedding 设置，请刷新后重试")
            if row is None:
                row = KnowledgeProfileRow(id="active")
                dao.add(row)
            row.profile, row.credential, row.version = profile, credential, body.version + 1
        if self.audit:
            await self.audit(
                account.user_id,
                "knowledge.embedding.update",
                str(profile["id"]),
                {"indexedAssets": len(documents), "revision": profile["revision"]},
            )
        return await self.view(account)

    async def prepare_local(self, account: Account) -> dict[str, object]:
        """显式下载固定本地模型，准备成功不自动改变活动外部配置。"""
        await self._authorize(account)
        result = await self.build(LOCAL_PROFILE, None).prepare_local()
        if self.audit:
            await self.audit(
                account.user_id, "knowledge.embedding.prepare", str(LOCAL_PROFILE["id"]), {}
            )
        return result

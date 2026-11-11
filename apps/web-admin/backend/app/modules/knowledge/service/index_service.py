"""持久化索引状态机：准备、执行、失败及重试有明确的代际和尝试身份。"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.knowledge.dao.knowledge_dao import KnowledgeDao
from app.modules.knowledge.entity.do.knowledge_do import KnowledgeDocumentRow
from app.modules.knowledge.service.embedding_service import EmbeddingService, embedding_generation
from app.modules.knowledge.service.qdrant_service import QdrantService
from app.modules.knowledge.service.source_chunks import source_chunks


class KnowledgeIndexService:
    """不持有数据库事务等待外部编码；失败保留文档原文和上一有效索引。"""

    def __init__(self, database: Database, qdrant: QdrantService) -> None:
        self.database, self.qdrant = database, qdrant

    async def initialize(self) -> None:
        """旧任务超时后标为失败，可显式重试；不把未知结果当作完成。"""
        async with self.database.sessions() as session, session.begin():
            await KnowledgeDao(session).interrupted(datetime.now(UTC) - timedelta(minutes=5))

    async def statuses(
        self, owner: str, assets: list[dict[str, object]], embedding: EmbeddingService
    ) -> list[dict[str, object]]:
        """状态来自持久任务，不依赖浏览器轮询期间的进程内缓存。"""
        await self.initialize()
        generation = embedding_generation(embedding.profile)
        values: list[dict[str, object]] = []
        async with self.database.sessions() as session:
            dao = KnowledgeDao(session)
            for asset in assets:
                row = await dao.document(owner, str(asset["id"]), generation)
                values.append(
                    {
                        "assetId": asset["id"],
                        "sha256": asset["sha256"],
                        "filename": asset["name"],
                        "generation": generation,
                        "state": row.state if row and row.sha256 == asset["sha256"] else "pending",
                        "chunks": row.chunks if row else len(source_chunks(asset)),
                        **({"operationId": row.attempt} if row else {}),
                        **({"message": row.message} if row and row.message else {}),
                    }
                )
        return values

    async def index(
        self,
        owner: str,
        assets: list[dict[str, object]],
        embedding: EmbeddingService,
        force: bool = False,
    ) -> dict[str, object]:
        """失败文档可重试，正在运行的同一文档返回冲突，迟到任务不覆盖新尝试。"""
        generation = embedding_generation(embedding.profile)
        total = 0
        operation_ids: list[str] = []
        for asset in assets:
            identifier, attempt = str(asset["id"]), uuid4().hex
            async with self.database.sessions() as session, session.begin():
                await lock_transaction(
                    session, "knowledge-index:" + owner + ":" + identifier + ":" + generation
                )
                dao = KnowledgeDao(session)
                row = await dao.document(owner, identifier, generation)
                now = datetime.now(UTC)
                if row and row.state == "ready" and row.sha256 == asset["sha256"] and not force:
                    total += row.chunks
                    operation_ids.append(row.attempt)
                    continue
                if row and row.state == "indexing" and row.updated_at > now - timedelta(minutes=5):
                    raise DomainError(409, "资料索引正在处理中，请稍后查看状态")
                if row is None:
                    row = KnowledgeDocumentRow(
                        owner_id=owner, asset_id=identifier, generation=generation
                    )
                    dao.add(row)
                row.sha256, row.filename, row.attempt = (
                    str(asset["sha256"]),
                    str(asset["name"]),
                    attempt,
                )
                row.state, row.chunks, row.message, row.updated_at = "indexing", 0, None, now
                operation_ids.append(attempt)
            try:
                # 每个文档有整体截止时间，防止分批超时累加形成无界任务。
                async with asyncio.timeout(240):
                    count = await self.qdrant.index(owner, asset, embedding)
                await self._finish(owner, identifier, generation, attempt, "ready", count, None)
                total += count
            except asyncio.CancelledError:
                await asyncio.shield(
                    self._finish(
                        owner, identifier, generation, attempt, "failed", 0, "索引已取消，可重试"
                    )
                )
                raise
            except Exception as error:
                message = (
                    error.detail if isinstance(error, DomainError) else "资料索引超时或失败，请重试"
                )
                await self._finish(owner, identifier, generation, attempt, "failed", 0, message)
                if isinstance(error, DomainError):
                    raise
                raise DomainError(503, message) from error
        return {"indexedAssets": len(assets), "chunks": total, "operationIds": operation_ids}

    async def _finish(
        self,
        owner: str,
        identifier: str,
        generation: str,
        attempt: str,
        state: str,
        chunks: int,
        message: str | None,
    ) -> None:
        async with self.database.sessions() as session, session.begin():
            await lock_transaction(
                session, "knowledge-index:" + owner + ":" + identifier + ":" + generation
            )
            row = await KnowledgeDao(session).document(owner, identifier, generation)
            if row and row.attempt == attempt:
                row.state, row.chunks, row.message, row.updated_at = (
                    state,
                    chunks,
                    message,
                    datetime.now(UTC),
                )

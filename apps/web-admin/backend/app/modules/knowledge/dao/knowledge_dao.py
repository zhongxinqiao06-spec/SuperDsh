"""知识配置与任务持久查询，状态迁移由服务层约束。"""

from datetime import datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.knowledge.entity.do.knowledge_do import KnowledgeDocumentRow, KnowledgeProfileRow


class KnowledgeDao:
    """同一文档按 owner、asset、generation 唯一定位。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def profile(self) -> KnowledgeProfileRow | None:
        """只保存一个全局配置对象。"""
        return await self.session.get(KnowledgeProfileRow, "active")

    async def document(
        self, owner: str, asset: str, generation: str
    ) -> KnowledgeDocumentRow | None:
        """返回某个资料的指定代际，不把其他账号状态混入。"""
        return await self.session.get(KnowledgeDocumentRow, (owner, asset, generation))

    async def interrupted(self, before: datetime) -> None:
        """恢复仅处理超时任务，避免另一实例正在运行的任务被启动扫描打断。"""
        await self.session.execute(
            update(KnowledgeDocumentRow)
            .where(
                KnowledgeDocumentRow.state.in_(["pending", "indexing"]),
                KnowledgeDocumentRow.updated_at < before,
            )
            .values(state="failed", message="上次索引任务中断，请重试")
        )

    def add(self, value: KnowledgeDocumentRow | KnowledgeProfileRow) -> None:
        """调用方持有事务边界。"""
        self.session.add(value)

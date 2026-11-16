"""智能体资产元数据访问；身份判断和事务边界留在服务层。"""

from sqlalchemy import ColumnElement, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.agents.entity.do.agent_do import AgentAssetRow


class AgentDao:
    """所有查询显式接收账号作用域。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    def scope(self, owner: str, product: str | None) -> ColumnElement[bool]:
        if product is None:
            return AgentAssetRow.owner_id == owner
        if product == "office":
            return or_(
                AgentAssetRow.product == product,
                and_(AgentAssetRow.owner_id == owner, AgentAssetRow.product == "personal"),
            )
        return AgentAssetRow.product == product

    async def assets(self, owner: str, product: str | None = None) -> list[AgentAssetRow]:
        """按上传时间列出账号资产。"""
        return list(
            (
                await self.session.scalars(
                    select(AgentAssetRow)
                    .where(self.scope(owner, product), AgentAssetRow.deleted_at.is_(None))
                    .order_by(AgentAssetRow.created_at.desc(), AgentAssetRow.id)
                )
            ).all()
        )

    async def asset(
        self, owner: str, identifier: str, product: str | None = None
    ) -> AgentAssetRow | None:
        """未知和他人资产使用同一个查无结果语义。"""
        return await self.session.scalar(
            select(AgentAssetRow).where(
                self.scope(owner, product),
                AgentAssetRow.id == identifier,
                AgentAssetRow.deleted_at.is_(None),
            )
        )

    async def referenced(self, identifier: str) -> AgentAssetRow | None:
        """仅供服务在验证具体资源/冻结绑定的引用关系后按稳定身份取文件。"""
        return await self.session.scalar(
            select(AgentAssetRow).where(
                AgentAssetRow.id == identifier, AgentAssetRow.deleted_at.is_(None)
            )
        )

    async def matching(
        self, owner: str, kind: str, name: str, digest: str, product: str = "personal"
    ) -> AgentAssetRow | None:
        """幂等键包含内容摘要，不按文件名覆盖已有资料。"""
        return await self.session.scalar(
            select(AgentAssetRow).where(
                AgentAssetRow.owner_id == owner,
                AgentAssetRow.product == product,
                AgentAssetRow.kind == kind,
                AgentAssetRow.name == name,
                AgentAssetRow.sha256 == digest,
            )
        )

    async def documents(self) -> list[AgentAssetRow]:
        """全局模型代际准备读取资料，由调用服务明确检查部署管理权限。"""
        return list(
            (
                await self.session.scalars(
                    select(AgentAssetRow)
                    .where(AgentAssetRow.kind == "knowledge", AgentAssetRow.deleted_at.is_(None))
                    .order_by(AgentAssetRow.owner_id, AgentAssetRow.id)
                )
            ).all()
        )

    def add(self, row: AgentAssetRow) -> None:
        """调用方在短事务内提交新资产。"""
        self.session.add(row)

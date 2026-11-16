"""模型持久访问只组织查询，不判断权限或提交事务。"""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.models.entity.do.model_do import (
    ModelCapabilityDefaultRow,
    ModelConfigurationRow,
    ModelConfigurationVersionRow,
    ModelConnectionRow,
    ModelDefaultRow,
    ModelOperationRow,
    ModelProviderRow,
    ProductModelDefaultRow,
)


class ModelDao:
    """所有修改由调用方持有模型事务锁和提交边界。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def providers(self, owner: str | None) -> list[ModelProviderRow]:
        return list(
            (
                await self.session.scalars(
                    select(ModelProviderRow)
                    .where(ModelProviderRow.owner_id == owner)
                    .order_by(ModelProviderRow.name, ModelProviderRow.id)
                )
            ).all()
        )

    async def provider(self, identifier: str) -> ModelProviderRow | None:
        return await self.session.get(ModelProviderRow, identifier)

    async def default(self, scope: str) -> ModelDefaultRow | None:
        return await self.session.get(ModelDefaultRow, scope)

    async def selected_defaults(self, provider: str) -> list[ModelDefaultRow]:
        return list(
            (
                await self.session.scalars(
                    select(ModelDefaultRow).where(ModelDefaultRow.provider_id == provider)
                )
            ).all()
        )

    async def delete_defaults(self, provider: str) -> None:
        await self.session.execute(
            delete(ModelDefaultRow).where(ModelDefaultRow.provider_id == provider)
        )

    async def connections(self) -> list[ModelConnectionRow]:
        return list(
            (
                await self.session.scalars(
                    select(ModelConnectionRow).order_by(
                        ModelConnectionRow.name, ModelConnectionRow.id
                    )
                )
            ).all()
        )

    async def connection(self, identifier: str) -> ModelConnectionRow | None:
        return await self.session.get(ModelConnectionRow, identifier)

    async def configurations(self, connection: str | None = None) -> list[ModelConfigurationRow]:
        query = select(ModelConfigurationRow).order_by(
            ModelConfigurationRow.name, ModelConfigurationRow.id
        )
        if connection is not None:
            query = query.where(ModelConfigurationRow.connection_id == connection)
        return list((await self.session.scalars(query)).all())

    async def configuration(self, identifier: str) -> ModelConfigurationRow | None:
        return await self.session.get(ModelConfigurationRow, identifier)

    async def configuration_version(
        self, identifier: str, revision: int
    ) -> ModelConfigurationVersionRow | None:
        return await self.session.get(ModelConfigurationVersionRow, (identifier, revision))

    async def product_defaults(self, product: str) -> list[ProductModelDefaultRow]:
        query = select(ProductModelDefaultRow).where(ProductModelDefaultRow.product == product)
        return list(await self.session.scalars(query))

    async def product_default(self, product: str, capability: str) -> ProductModelDefaultRow | None:
        return await self.session.get(ProductModelDefaultRow, (product, capability))

    async def capability_defaults(self) -> list[ModelCapabilityDefaultRow]:
        return list((await self.session.scalars(select(ModelCapabilityDefaultRow))).all())

    async def capability_default(self, capability: str) -> ModelCapabilityDefaultRow | None:
        return await self.session.get(ModelCapabilityDefaultRow, capability)

    async def operation(self, identifier: str, owner: str) -> ModelOperationRow | None:
        return await self.session.scalar(
            select(ModelOperationRow).where(
                ModelOperationRow.id == identifier, ModelOperationRow.owner_id == owner
            )
        )

    async def completed_operation(
        self, owner: str, scope: str, configuration: str, revision: int, request_hash: str
    ) -> ModelOperationRow | None:
        """仅取同一所有者、业务范围和冻结请求的已完成结果，未知收据不进入复用。"""
        return await self.session.scalar(
            select(ModelOperationRow)
            .where(
                ModelOperationRow.owner_id == owner,
                ModelOperationRow.session_id == scope,
                ModelOperationRow.configuration_id == configuration,
                ModelOperationRow.configuration_revision == revision,
                ModelOperationRow.request_hash == request_hash,
                ModelOperationRow.state == "completed",
            )
            .order_by(ModelOperationRow.updated_at.desc(), ModelOperationRow.id)
            .limit(1)
        )

    def add(
        self,
        value: ModelProviderRow
        | ModelDefaultRow
        | ModelConnectionRow
        | ModelConfigurationRow
        | ModelConfigurationVersionRow
        | ModelCapabilityDefaultRow
        | ProductModelDefaultRow
        | ModelOperationRow,
    ) -> None:
        self.session.add(value)

    async def remove(
        self, value: ModelProviderRow | ModelDefaultRow | ProductModelDefaultRow
    ) -> None:
        await self.session.delete(value)

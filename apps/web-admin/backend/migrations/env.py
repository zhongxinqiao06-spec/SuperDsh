"""独立新库迁移；未知已有结构明确拒绝，不接管旧平台数据库。"""

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, inspect
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.database import Base
from app.modules.agents.entity.do import agent_do
from app.modules.conversations.entity.do import models as conversation_models
from app.modules.devices.entity.do import models as device_models
from app.modules.devices.entity.do import operation_do as device_operation_models
from app.modules.extensions.entity.do import models as extension_models
from app.modules.files.entity.do import models as file_models
from app.modules.identity.entity.do import account_models
from app.modules.identity.entity.do import models as identity_models
from app.modules.knowledge.entity.do import knowledge_do
from app.modules.management.entity.do import models as management_models
from app.modules.models.entity.do import model_do
from app.modules.navigation.entity.do import models as navigation_models
from app.modules.resources.entity.do import models as resource_models
from app.modules.runtime.entity.do import models as runtime_models
from app.modules.skills.entity.do import models as skill_models

# 导入只注册自有 DO 元数据，历史 revision 文件不依赖这份可变模型。
MODEL_MODULES = (
    identity_models,
    navigation_models,
    resource_models,
    runtime_models,
    skill_models,
    account_models,
    management_models,
    model_do,
    agent_do,
    knowledge_do,
    file_models,
    device_models,
    device_operation_models,
    conversation_models,
    extension_models,
)
config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)
url = os.environ["WEB_ADMIN_DATABASE_URL"]
if not url.startswith("postgresql+asyncpg://"):
    raise RuntimeError("迁移必须显式使用独立 PostgreSQL asyncpg 数据库")


def migrate(connection: Connection) -> None:
    """已存在业务表但无新迁移账本时中止，绝不自动 stamp。"""
    tables = set(inspect(connection).get_table_names())
    if tables and "alembic_version" not in tables:
        raise RuntimeError("目标存在未知结构；请使用独立空库，不允许自动接管")
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def online() -> None:
    """连接在失败或成功后均释放，DDL 由 PostgreSQL 事务仲裁。"""
    # 迁移先于应用连接池运行，也必须限制建连等待；不限制正常 DDL 的执行时长。
    engine = create_async_engine(url, connect_args={"timeout": 10})
    try:
        async with engine.begin() as connection:
            await connection.run_sync(migrate)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(online())

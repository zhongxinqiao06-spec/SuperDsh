"""提供账务管理台可读取的账号字段及办理所需产品资格。"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.selectable import Subquery

from app.infrastructure.errors import DomainError
from app.modules.identity.dao.billing_directory import directory_projection, eligible_name


def account_directory() -> Subquery:
    """公共只读投影限定字段，允许账务在数据库完成联表筛选和分页。"""
    return directory_projection()


async def require_billing_customer(session: AsyncSession, owner: str) -> str:
    """与办理共用事务并锁定目标账号，停用、删除或无产品资格时拒绝发放。"""
    name = await eligible_name(session, owner)
    if name is None:
        raise DomainError(409, "账号已停用、已删除或尚无产品资格")
    return name

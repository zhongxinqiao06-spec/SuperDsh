"""向账务提供最小账户投影及与账号启停串行的资格读取。"""

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.selectable import Subquery

from app.modules.identity.entity.bo.product_roles import UNLIMITED_CREDIT_ROLES
from app.modules.identity.entity.do.models import RoleRow, UserRow


def directory_projection() -> Subquery:
    return (
        select(
            UserRow.id,
            UserRow.username,
            UserRow.display_name,
            UserRow.disabled,
            or_(*(UserRow.roles.contains([role]) for role in UNLIMITED_CREDIT_ROLES)).label(
                "unlimited"
            ),
        )
        .where(UserRow.deleted_at.is_(None))
        .subquery("billing_accounts")
    )


async def eligible_name(session: AsyncSession, owner: str) -> str | None:
    user = await session.scalar(
        select(UserRow)
        .where(UserRow.id == owner, UserRow.disabled.is_(False), UserRow.deleted_at.is_(None))
        .with_for_update()
    )
    if not user:
        return None
    grant = await session.scalar(
        select(RoleRow.id)
        .where(
            RoleRow.id.in_(user.roles),
            or_(
                RoleRow.permissions.contains(["products.office"]),
                RoleRow.permissions.contains(["products.entertainment"]),
            ),
        )
        .limit(1)
    )
    return user.username if grant else None

"""从认证主体与产品参数建立资源管理范围，执行接口继续使用原始主体。"""

from typing import Annotated

from fastapi import Depends

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import Product
from app.modules.resources.entity.bo.product_scope import scope_resources


async def product_resource_account(
    account: Annotated[Account, Depends(current_account)], product: Product | None = None
) -> Account:
    return scope_resources(account, product)


ResourceAccount = Annotated[Account, Depends(product_resource_account)]

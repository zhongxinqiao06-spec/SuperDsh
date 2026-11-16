"""资源管理请求的授权范围，在应用层随账号传递，不修改持久角色或用户权限。"""

from dataclasses import dataclass, fields

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import Product


@dataclass(kw_only=True)
class ProductResourceAccount(Account):
    """只有资源管理入口能建立此范围，平台模型、扩展及账号等能力不受该授权影响。"""

    product: Product

    def require(self, permission: str) -> None:
        if permission == "agents.manage":
            if "agents.manage" in self.permissions:
                super().require("agents.manage")
                super().require("products." + self.product)
            else:
                self.require_product_management(self.product, "resources")
        else:
            super().require(permission)


def scope_resources(account: Account, product: Product | None) -> Account:
    """缺省产品使用原来的平台授权；显式产品必须检查对应的资源权限。"""
    if product is None:
        return account
    if "agents.manage" in account.permissions:
        account.require("products." + product)
        account.require("agents.manage")
    else:
        account.require_product_management(product, "resources")
    return ProductResourceAccount(
        **{field.name: getattr(account, field.name) for field in fields(Account)}, product=product
    )


def resource_product(account: Account) -> Product | None:
    return account.product if isinstance(account, ProductResourceAccount) else None


def writing_product(account: Account, kind: str, value: object) -> None:
    """历史恢复、批量导入和普通写入使用同一产品限制，跨端共享仅由平台发布。"""
    if value not in ("office", "entertainment", "shared") or (
        value == "shared" and kind == "agent"
    ):
        raise DomainError(422, "资源产品范围无效")
    if value == "shared" and "agents.manage" not in account.permissions:
        raise DomainError(403, "共享资源需要平台管理权限")
    if isinstance(account, ProductResourceAccount) and value not in (account.product, "shared"):
        raise DomainError(403, "不能管理其他产品的资源")

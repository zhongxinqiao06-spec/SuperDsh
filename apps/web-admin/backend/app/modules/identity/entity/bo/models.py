"""身份实体与权限判断，不依赖 HTTP 或数据库。"""

from dataclasses import dataclass, field
from datetime import datetime

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.product_roles import (
    PRODUCT_GRANTS,
    Product,
    ProductArea,
    product_grant,
)

PERMISSIONS = {
    "studio.projects.read": "查看自己的娱乐作品",
    "studio.projects.write": "编辑自己的娱乐作品",
    "studio.assets.read": "查看自己的创作素材",
    "studio.assets.write": "管理自己的创作素材版本",
    "devices.read": "查看自己的设备",
    "devices.manage": "管理自己的设备",
    "sessions.read": "读取自己的会话",
    "sessions.run": "执行自己的会话",
    "projects.read": "查看自己的项目",
    "projects.manage": "管理自己的项目",
    "files.read": "读取自己的文件",
    "files.write": "写入自己的文件",
    "terminal.use": "使用自己的终端",
    "models.personal.manage": "配置个人模型",
    "models.use": "使用已配置模型",
    "users.read": "查看账号",
    "billing.read": "查看会员与账务",
    "billing.rates.manage": "维护和发布模型扣点费率",
    "billing.plans.manage": "发布、上下架与撤回套餐版本",
    "billing.subscriptions.manage": "办理会员开通与续期",
    "billing.adjustments.create": "办理人工加额",
    "billing.receipts.record": "登记线下收款",
    "users.manage": "管理账号",
    "roles.manage": "管理角色",
    "menus.read": "查看菜单配置",
    "menus.manage": "配置导航菜单",
    "devices.inventory.read": "查看设备资产",
    "devices.connection.manage": "管理设备连接",
    "settings.manage": "管理平台设置",
    "models.manage": "管理平台模型",
    "audit.read": "查看管理审计",
    "agents.manage": "管理智能体资源",
    "extensions.manage": "安装扩展与管理MCP",
    "products.office": "进入星桥办公",
    "products.entertainment": "进入星桥娱乐",
    "storage.manage": "管理存储配置",
    **PRODUCT_GRANTS,
}


@dataclass
class Account:
    """已解析账号授权；管理员权限不自动赋予其他账号资源所有权。"""

    user_id: str
    username: str
    roles: tuple[str, ...]
    permissions: tuple[str, ...]
    auth_version: int
    disabled: bool = False
    session_id: str = ""
    email: str | None = None
    display_name: str | None = None
    deleted_at: datetime | None = None
    reset_required: bool = False
    revision: int = 1
    avatar_url: str | None = None
    email_verified_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    def require(self, permission: str) -> None:
        """每次用例入口重新授权，重置要求禁止继续业务操作。"""
        if self.reset_required:
            raise DomainError(403, "password change required")
        if self.disabled or self.deleted_at or permission not in self.permissions:
            raise DomainError(403, f"permission required: {permission}")

    def can_manage_product(self, product: Product, area: ProductArea) -> bool:
        """展示与领域授权共享判断；两项权限均须属于目标产品。"""
        return (
            not self.reset_required
            and not self.disabled
            and self.deleted_at is None
            and "products." + product in self.permissions
            and product_grant(product, area) in self.permissions
        )

    def require_product_management(self, product: Product, area: ProductArea) -> None:
        """同时校验产品使用权和该产品的具体管理操作，显式拒绝串权。"""
        self.require("products." + product)
        self.require(product_grant(product, area))


@dataclass
class User:
    """持久账号记录；密码摘要只在身份用例内部流转。"""

    id: str
    username: str
    password_hash: str
    roles: list[str] = field(default_factory=lambda: ["member"])
    email: str | None = None
    display_name: str | None = None
    disabled: bool = False
    deleted_at: datetime | None = None
    reset_required: bool = False
    auth_version: int = 0
    revision: int = 1
    avatar_url: str | None = None
    email_verified_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Role:
    """角色权限从数据库读取，内置角色也有明确保护。"""

    id: str
    name: str
    description: str
    permissions: list[str]
    builtin: bool = False
    revision: int = 1


@dataclass
class LoginSession:
    """刷新令牌轮换记录；重放上次令牌会撤销当前会话。"""

    id: str
    user_id: str
    refresh_hash: str
    auth_version: int
    client_name: str
    created_at: datetime
    expires_at: datetime
    previous_refresh_hash: str | None = None
    revoked_at: datetime | None = None
    last_seen_at: datetime | None = None

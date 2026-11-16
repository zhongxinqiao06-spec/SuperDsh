"""两个产品的内置角色、权限清单及授权键，账号可同时承担不同产品的职责。"""

from typing import Literal

Product = Literal["office", "entertainment"]
ProductArea = Literal["members", "menus", "resources", "models"]

PRODUCTS: dict[Product, str] = {"office": "办公", "entertainment": "娱乐"}
AREAS: dict[ProductArea, str] = {
    "members": "产品成员",
    "menus": "产品菜单",
    "resources": "产品能力发布",
    "models": "产品默认模型",
}


def product_grant(product: Product, area: ProductArea) -> str:
    """权限键包含业务产品，不能用另一端的管理权拼接进入权限。"""
    return f"products.{product}.{area}.manage"


PRODUCT_GRANTS = {
    product_grant(product, area): f"管理{title}{label}"
    for product, title in PRODUCTS.items()
    for area, label in AREAS.items()
}

# 保持旧办公使用者的个人设备、终端与个人模型授权，不以字典顺序推导权限。
OFFICE_USER_GRANTS = (
    "devices.read",
    "devices.manage",
    "sessions.read",
    "sessions.run",
    "projects.read",
    "projects.manage",
    "files.read",
    "files.write",
    "terminal.use",
    "models.personal.manage",
    "models.use",
    "products.office",
)
CREATOR_GRANTS = (
    "studio.projects.read",
    "studio.projects.write",
    "studio.assets.read",
    "studio.assets.write",
    "sessions.read",
    "sessions.run",
    "files.read",
    "files.write",
    "models.use",
    "products.entertainment",
)
MEMBER_ROLE: dict[Product, str] = {"office": "member", "entertainment": "entertainment_creator"}
PRODUCT_ADMIN_ROLE: dict[Product, str] = {
    "office": "office_admin",
    "entertainment": "entertainment_admin",
}
ROLE_TITLES = {
    "admin": "平台超级管理员",
    "member": "办公用户",
    "office_admin": "办公管理员",
    "entertainment_admin": "娱乐管理员",
    "entertainment_creator": "娱乐创作者",
}


def builtin_grants(platform_permissions: dict[str, str]) -> dict[str, list[str]]:
    """仅超管拥有全平台管理能力，产品管理员继承本产品使用者的个人业务能力。"""
    roles = {"admin": list(platform_permissions)}
    for product in PRODUCTS:
        user_grants = list(OFFICE_USER_GRANTS if product == "office" else CREATOR_GRANTS)
        roles[MEMBER_ROLE[product]] = user_grants
        roles[PRODUCT_ADMIN_ROLE[product]] = [
            *user_grants,
            *(product_grant(product, area) for area in AREAS),
        ]
    return roles

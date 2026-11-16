"""无版本导航路由，配置写入使用乐观版本。"""

from dataclasses import replace
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.navigation.entity.bo.navigation import Product
from app.modules.navigation.entity.vo.dto import MenuInput, MenuResetInput
from app.modules.navigation.service.navigation import NavigationService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> NavigationService:
    return request.app.state.services.navigation


@router.get("/navigation")
async def navigation(
    request: Request, account: AccountDep, product: Product | None = None
) -> dict[str, object]:
    """获取当前账号真正可见的导航。"""
    result = await service(request).catalog(account, product=product)
    return {"version": result["version"], "items": result["items"]}


@router.get("/admin/menus")
async def menus(
    request: Request, account: AccountDep, product: Product = "office"
) -> dict[str, object]:
    """管理读取同时给出模块和图标目录。"""
    result = await service(request).catalog(account, True, product)
    result["roles"] = await request.app.state.services.identity.role_choices(account, product)
    return result


@router.get("/admin/menus/preview")
async def preview(
    request: Request, account: AccountDep, product: Product, roleId: str
) -> dict[str, object]:
    """使用角色当前实际授权预览已保存的菜单；不签发被预览角色的身份或令牌。"""
    grants = await request.app.state.services.identity.menu_role_permissions(
        account, product, roleId
    )
    if "products." + product not in grants:
        return {
            "items": [],
            "version": (await service(request).catalog(account, True, product))["version"],
        }
    preview_account = replace(account, roles=(roleId,), permissions=tuple(grants))
    result = await service(request).catalog(preview_account, product=product)
    return {"items": result["items"], "version": result["version"]}


@router.put("/admin/menus")
async def save_menu(
    body: MenuInput, request: Request, account: AccountDep, product: Product = "office"
) -> dict[str, object]:
    """冲突原样返回给前端，不能覆盖未保存草稿。"""
    await service(request).save(account, body.version, body.items, product)
    return await menus(request, account, product)


@router.post("/admin/menus/reset")
async def reset_menu(
    body: MenuResetInput, request: Request, account: AccountDep, product: Product = "office"
) -> dict[str, object]:
    """显式恢复默认也受版本和权限保护。"""
    await service(request).save(account, body.version, None, product)
    return await menus(request, account, product)

"""无版本导航路由，配置写入使用乐观版本。"""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.navigation.entity.vo.dto import MenuInput, MenuResetInput
from app.modules.navigation.service.navigation import NavigationService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> NavigationService:
    return request.app.state.services.navigation


@router.get("/navigation")
async def navigation(request: Request, account: AccountDep) -> dict[str, object]:
    """获取当前账号真正可见的导航。"""
    result = await service(request).catalog(account)
    return {"version": result["version"], "items": result["items"]}


@router.get("/admin/menus")
async def menus(request: Request, account: AccountDep) -> dict[str, object]:
    """管理读取同时给出模块和图标目录。"""
    result = await service(request).catalog(account, True)
    result["roles"] = await request.app.state.services.identity.role_choices(account)
    return result


@router.put("/admin/menus")
async def save_menu(body: MenuInput, request: Request, account: AccountDep) -> dict[str, object]:
    """冲突原样返回给前端，不能覆盖未保存草稿。"""
    value = await service(request).save(account, body.version, body.items)
    return {**await menus(request, account), **asdict(value)}


@router.post("/admin/menus/reset")
async def reset_menu(
    body: MenuResetInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """显式恢复默认也受版本和权限保护。"""
    value = await service(request).save(account, body.version, None)
    return {**await menus(request, account), **asdict(value)}

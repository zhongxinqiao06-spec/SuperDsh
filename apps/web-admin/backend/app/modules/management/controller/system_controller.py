"""系统设置、公告和总览的 HTTP 契约。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.management.entity.vo.system_vo import (
    AnnouncementInput,
    DashboardSettingsPatchInput,
    ServiceSettingsInput,
)
from app.modules.management.service.dashboard_service import Dashboard
from app.modules.management.service.system_service import SystemManagement

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def system(request: Request) -> SystemManagement:
    return request.app.state.services.system


@router.get("/admin/settings")
async def settings(request: Request, account: AccountDep) -> dict[str, object]:
    return await system(request).settings(account)


@router.patch("/admin/settings")
async def update_settings(
    body: ServiceSettingsInput, request: Request, account: AccountDep
) -> dict[str, object]:
    return await system(request).update_settings(account, body)


@router.get("/admin/service")
async def service(request: Request, account: AccountDep) -> dict[str, object]:
    return system(request).service_information(account)


@router.get("/announcement")
async def announcement(request: Request) -> dict[str, object]:
    return await system(request).announcement()


@router.get("/admin/announcement")
async def admin_announcement(request: Request, account: AccountDep) -> dict[str, object]:
    return await system(request).announcement(account)


@router.put("/admin/announcement")
async def publish(
    body: AnnouncementInput, request: Request, account: AccountDep
) -> dict[str, object]:
    return await system(request).publish(account, body)


@router.get("/admin/dashboard/settings")
async def dashboard_settings(request: Request, account: AccountDep) -> dict[str, object]:
    return await Dashboard(system(request)).settings(account)


@router.patch("/admin/dashboard/settings")
async def update_dashboard(
    body: DashboardSettingsPatchInput, request: Request, account: AccountDep
) -> dict[str, object]:
    return await Dashboard(system(request)).update(account, body)


@router.get("/admin/dashboard/overview")
async def overview(
    request: Request,
    account: AccountDep,
    from_date: str = Query("", alias="from"),
    to_date: str = Query("", alias="to"),
    tz: str = Query("Asia/Shanghai", max_length=100),
) -> dict[str, object]:
    return await Dashboard(system(request)).overview(account, from_date, to_date, tz)


@router.post("/admin/dashboard/snapshots/{target_date}")
async def snapshot(
    target_date: str,
    request: Request,
    account: AccountDep,
    tz: str = Query("Asia/Shanghai", max_length=100),
) -> dict[str, object]:
    return await Dashboard(system(request)).snapshot(account, target_date, tz)

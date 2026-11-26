"""平台套餐目录、版本发布与撤回，沿用后台账务的查看权限。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from app.api.dependencies import current_account
from app.modules.billing.entity.vo.catalog import (
    CatalogCommand,
    PlanDirectory,
    PlanRelease,
    PublishPlan,
    ReleaseHistory,
)
from app.modules.billing.service.catalog_service import CatalogManagement
from app.modules.identity.entity.bo.models import Account

router = APIRouter(prefix="/admin/billing/plans")
Actor = Annotated[Account, Depends(current_account)]
Sku = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]
Page = Annotated[int, Query(ge=1, le=1000000)]
Size = Annotated[int, Query(ge=1, le=100)]


def service(request: Request) -> CatalogManagement:
    return request.app.state.services.catalog_management


@router.get("")
async def plans(
    request: Request,
    account: Actor,
    page: Page = 1,
    pageSize: Size = 10,
    search: Annotated[str, Query(max_length=64)] = "",
    exact: bool = False,
) -> PlanDirectory:
    return await service(request).directory(account, search.strip(), page, pageSize, exact)


@router.get("/{sku}/versions")
async def versions(
    sku: Sku, request: Request, account: Actor, page: Page = 1, pageSize: Size = 10
) -> ReleaseHistory:
    return await service(request).history(account, sku, page, pageSize)


@router.post("/{sku}/versions")
async def publish(sku: Sku, body: PublishPlan, request: Request, account: Actor) -> PlanRelease:
    return await service(request).publish(account, sku, body)


@router.post("/{sku}/versions/{revision}/withdraw")
async def withdraw(
    sku: Sku,
    revision: Annotated[int, Path(ge=1, le=2147483647)],
    body: CatalogCommand,
    request: Request,
    account: Actor,
) -> PlanRelease:
    return await service(request).withdraw(account, sku, revision, body)

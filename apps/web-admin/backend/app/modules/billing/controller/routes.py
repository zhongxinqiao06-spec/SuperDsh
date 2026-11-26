"""本人可见的会员、试行套餐与流水，不接受由客户端指定的账本归属。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import AwareDatetime

from app.api.dependencies import current_account
from app.modules.billing.entity.vo.dto import Catalog, Entries, EntryDetail, Wallet
from app.modules.billing.service.membership_service import MembershipService
from app.modules.identity.entity.bo.models import Account

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> MembershipService:
    return request.app.state.services.billing


@router.get("/billing/catalog")
async def catalog(request: Request, account: AccountDep) -> Catalog:
    """查询当前展示的套餐及加购包。"""
    return await service(request).catalog(account)


@router.get("/me/billing")
async def wallet(request: Request, account: AccountDep) -> Wallet:
    """查询本人当前周期、余额和最近到期的批次。"""
    return await service(request).wallet(account)


@router.get("/me/billing/entries")
async def entries(
    request: Request,
    account: AccountDep,
    cursor: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    kind: Annotated[str | None, Query(min_length=1, max_length=32)] = None,
    since: AwareDatetime | None = None,
    until: AwareDatetime | None = None,
) -> Entries:
    """按时间倒序返回流水；时间窗口左闭右开。"""
    return await service(request).entries(account, cursor, limit, kind, since, until)


@router.get("/me/billing/entries/{entry_id}")
async def entry_detail(
    request: Request,
    account: AccountDep,
    entry_id: Annotated[str, Path(min_length=1, max_length=80)],
) -> EntryDetail:
    """查看本人当笔变动与原始发放批次。"""
    return await service(request).detail(account, entry_id)

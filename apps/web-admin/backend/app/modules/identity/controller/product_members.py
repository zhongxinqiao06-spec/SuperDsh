"""产品成员目录、普通成员授予与撤回的无版本入口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.bo.product_roles import Product
from app.modules.identity.entity.vo.product_members import MembershipInput, ProductMember
from app.modules.identity.service.product_members import ProductMemberships

router = APIRouter(prefix="/products/{product}/members")
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ProductMemberships:
    return request.app.state.services.management.product_members


@router.get("")
async def list_members(
    product: Product,
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1, le=1000000),
    pageSize: int = Query(10, ge=1, le=200),
    search: str = Query("", max_length=254),
) -> dict[str, object]:
    """服务端只返回本产品成员的必要资料和可操作状态。"""
    items, total = await service(request).list(account, product, page, pageSize, search)
    result: dict[str, object] = {"items": items, "total": total, "page": page, "pageSize": pageSize}
    if "billing.read" in account.permissions:
        summaries = await request.app.state.services.billing_operations.user_summaries(
            account, [item["userId"] for item in items]
        )
        result["items"] = [{**item, "billing": summaries.get(item["userId"])} for item in items]
    return result


@router.post("")
async def grant_member(
    product: Product, body: MembershipInput, request: Request, account: AccountDep
) -> ProductMember:
    """重复授予同一资格幂等，账号必须已由平台创建。"""
    return await service(request).grant(account, product, body.identifier)


@router.delete("/{user_id}", status_code=204)
async def revoke_member(
    product: Product,
    user_id: str,
    request: Request,
    account: AccountDep,
    revision: int = Query(ge=1),
) -> None:
    """撤回当前产品使用资格，保留另一产品的账号角色。"""
    await service(request).revoke(account, product, user_id, revision)

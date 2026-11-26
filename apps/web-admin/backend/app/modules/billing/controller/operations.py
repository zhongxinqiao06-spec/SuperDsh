"""平台运营只在持有对应账务权限时查询与办理。"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.billing.entity.vo.changes import (
    ChangeCommand,
    ChangeHistory,
    ChangeRecord,
    ScheduleInput,
)
from app.modules.billing.entity.vo.dto import Wallet
from app.modules.billing.entity.vo.operations import (
    BillingAccounts,
    ConfirmInput,
    Operation,
    OperationHistory,
    OperationInput,
)
from app.modules.billing.service.change_service import PlanChanges
from app.modules.billing.service.operations_service import BillingOperations
from app.modules.identity.entity.bo.models import Account

router = APIRouter(prefix="/admin/billing")
Actor = Annotated[Account, Depends(current_account)]
Page = Annotated[int, Query(ge=1, le=1000000)]
Size = Annotated[int, Query(ge=1, le=100)]


def service(request: Request) -> BillingOperations:
    return request.app.state.services.billing_operations


def changes(request: Request) -> PlanChanges:
    return request.app.state.services.plan_changes


@router.get("/subscriptions/{user_id}/changes")
async def change_history(
    user_id: str, request: Request, account: Actor, page: Page = 1, pageSize: Size = 10
) -> ChangeHistory:
    return await changes(request).history(account, user_id, page, pageSize)


@router.post("/subscriptions/{user_id}/changes")
async def schedule_change(
    user_id: str, body: ScheduleInput, request: Request, account: Actor
) -> ChangeRecord:
    return await changes(request).schedule(account, user_id, body)


@router.delete("/subscriptions/{user_id}/changes/{change_id}", response_model=ChangeRecord)
async def cancel_change(
    user_id: str, change_id: str, body: ChangeCommand, request: Request, account: Actor
) -> ChangeRecord | JSONResponse:
    try:
        return await changes(request).cancel(account, user_id, change_id, body)
    except DomainError as exc:
        if exc.code != "plan_change_effective":
            raise
        summary = await service(request).summary(account, user_id)
        return JSONResponse(
            status_code=409,
            content={
                "code": exc.code,
                "detail": exc.detail,
                "currentSubscription": summary.subscription.model_dump(mode="json", by_alias=True)
                if summary.subscription
                else None,
            },
        )


@router.get("/subscriptions")
async def accounts(
    request: Request,
    account: Actor,
    page: Page = 1,
    pageSize: Size = 10,
    search: Annotated[str, Query(max_length=100)] = "",
    state: Literal["active", "expired", "none"] | None = None,
    sku: Annotated[str | None, Query(max_length=64)] = None,
    expiringDays: Annotated[int | None, Query(ge=1, le=3650)] = None,
    userId: Annotated[str | None, Query(max_length=80)] = None,
) -> BillingAccounts:
    return await service(request).accounts(
        account, search.strip(), state, sku, expiringDays, page, pageSize, userId
    )


@router.get("/subscriptions/{user_id}/operations")
async def history(
    user_id: str, request: Request, account: Actor, page: Page = 1, pageSize: Size = 10
) -> OperationHistory:
    return await service(request).history(account, user_id, page, pageSize)


@router.get("/accounts/{user_id}/summary")
async def summary(user_id: str, request: Request, account: Actor) -> Wallet:
    return await service(request).summary(account, user_id)


@router.post("/operation-previews")
async def preview(body: OperationInput, request: Request, account: Actor) -> Operation:
    return await service(request).preview(account, body)


@router.post("/subscriptions")
async def subscription(body: ConfirmInput, request: Request, account: Actor) -> Operation:
    return await service(request).confirm(account, str(body.preview_id), True)


@router.post("/adjustments")
async def adjustment(body: ConfirmInput, request: Request, account: Actor) -> Operation:
    return await service(request).confirm(account, str(body.preview_id), False)

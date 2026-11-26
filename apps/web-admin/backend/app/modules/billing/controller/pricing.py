"""套餐与模型费率草稿、试算、发布和本人报价。"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.billing.entity.vo.pricing import (
    PlanDraft,
    PublishDraft,
    QuoteRequest,
    QuoteView,
    RateDraft,
    RateSnapshot,
    Trial,
    TrialView,
    Versions,
    VersionView,
)
from app.modules.billing.service.pricing_service import PricingManagement
from app.modules.billing.service.quote_service import QuoteService
from app.modules.identity.entity.bo.models import Account

router = APIRouter()
Actor = Annotated[Account, Depends(current_account)]
Page = Annotated[int, Query(ge=1, le=1000000)]
Size = Annotated[int, Query(ge=1, le=100)]
Search = Annotated[str, Query(max_length=420)]
State = Literal["all", "draft", "effective", "scheduled"]


def pricing(request: Request) -> PricingManagement:
    return request.app.state.services.pricing


def quotes(request: Request) -> QuoteService:
    return request.app.state.services.quotes


@router.get("/admin/billing/plan-versions", response_model=Versions[PlanDraft])
async def plan_drafts(
    request: Request,
    account: Actor,
    search: Search = "",
    page: Page = 1,
    pageSize: Size = 20,
    state: State = "draft",
) -> dict:
    return await pricing(request).directory(account, "plan", search, state, page, pageSize)


@router.post("/admin/billing/plan-versions", response_model=VersionView[PlanDraft])
async def save_plan(body: PlanDraft, request: Request, account: Actor) -> dict:
    return await pricing(request).save(account, body)


@router.post(
    "/admin/billing/plan-versions/{identity}/publish", response_model=VersionView[PlanDraft]
)
async def publish_plan(identity: str, body: PublishDraft, request: Request, account: Actor) -> dict:
    return await pricing(request).publish(account, "plan", identity, body)


@router.get("/admin/billing/rate-versions", response_model=Versions[RateSnapshot])
async def rates(
    request: Request,
    account: Actor,
    search: Search = "",
    state: State = "all",
    page: Page = 1,
    pageSize: Size = 20,
    capability: Search = "",
    model: Search = "",
    spec: Search = "",
    payer: Literal["personal", "platform"] | None = None,
    product: Literal["office", "entertainment"] | None = None,
) -> dict:
    filters = {
        k: v
        for k, v in {
            "capability": capability,
            "model": model,
            "spec": spec,
            "payer": payer,
            "product": product,
        }.items()
        if v
    }
    return await pricing(request).directory(account, "rate", search, state, page, pageSize, filters)


@router.post("/admin/billing/rate-versions", response_model=VersionView[RateSnapshot])
async def save_rate(body: RateDraft, request: Request, account: Actor) -> dict:
    return await pricing(request).save(account, body)


@router.post("/admin/billing/rate-previews", response_model=TrialView)
async def trial(body: Trial, request: Request, account: Actor) -> dict:
    return await quotes(request).trial(account, body)


@router.post(
    "/admin/billing/rate-versions/{identity}/publish", response_model=VersionView[RateSnapshot]
)
async def publish_rate(identity: str, body: PublishDraft, request: Request, account: Actor) -> dict:
    return await pricing(request).publish(account, "rate", identity, body)


@router.post("/billing/usage-quotes", response_model=QuoteView)
async def usage_quote(body: QuoteRequest, request: Request, account: Actor) -> dict:
    return await quotes(request).quote(account, body)


@router.get("/billing/usage-quotes/{identity}", response_model=QuoteView)
async def original_quote(identity: str, request: Request, account: Actor) -> dict:
    return await quotes(request).lookup(account, identity)

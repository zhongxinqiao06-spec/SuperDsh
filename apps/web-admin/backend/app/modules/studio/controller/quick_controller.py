"""快速创作入口只转换协议，复用媒体任务的授权、预检、队列与回执。"""

from fastapi import APIRouter, Request

from app.modules.studio.controller.studio_controller import User
from app.modules.studio.entity.vo.production_vo import ConfirmPlan
from app.modules.studio.entity.vo.quick_vo import CollectQuick, PromoteQuick, QuickIntent, SaveQuick

router = APIRouter(prefix="/studio", tags=["快速创作"])


@router.get("/quick-capabilities")
async def capabilities(request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.quick.generation.capabilities(account)


@router.get("/projects/{project}/quick")
async def state(project: str, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.quick.state(account, project)


@router.put("/projects/{project}/quick")
async def save(project: str, body: SaveQuick, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.quick.save(account, project, body)


@router.post("/projects/{project}/quick/generation-plans")
async def prepare(project: str, body: QuickIntent, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.quick.generation.prepare(
        account, project, body
    )


@router.post("/projects/{project}/quick/generation-plans/{plan}/confirm")
async def confirm(
    project: str, plan: str, body: ConfirmPlan, request: Request, account: User
) -> dict:
    return await request.app.state.services.media_jobs.quick.generation.confirm(
        account, project, plan, body
    )


@router.post("/projects/{project}/quick/promote")
async def promote(project: str, body: PromoteQuick, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.quick.promote(account, project, body)


@router.post("/projects/{project}/quick/collect")
async def collect(project: str, body: CollectQuick, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.quick.collect(account, project, body)

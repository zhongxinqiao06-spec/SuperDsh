"""制作预检、个人库候选与任务处置协议；权限和事务由领域服务统一负责。"""

from fastapi import APIRouter, Request, Response
from starlette.responses import FileResponse

from app.modules.studio.controller.studio_controller import User, media_account, set_media_access
from app.modules.studio.entity.vo.production_vo import (
    ConfirmPlan,
    JobDecision,
    PersonalAdopt,
    PersonalIntent,
    ProductionIntent,
)

router = APIRouter(prefix="/studio", tags=["studio-production"])


@router.get("/assets/{asset}/metadata")
async def media_metadata(
    asset: str, request: Request, account: User, project: str | None = None
) -> dict:
    """素材元数据仍按源版本与作品归属授权，不接收任意文件路径。"""
    return await request.app.state.services.media_jobs.sources.metadata(account, asset, project)


@router.post("/projects/{project}/generation-plans")
async def prepare(project: str, body: ProductionIntent, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.production.prepare(account, project, body)


@router.post("/projects/{project}/generation-plans/{plan}/confirm")
async def confirm(
    project: str, plan: str, body: ConfirmPlan, request: Request, account: User
) -> dict:
    return await request.app.state.services.media_jobs.production.confirm(
        account, project, plan, body
    )


@router.get("/entities/{entity}/production")
async def personal_state(entity: str, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.personal.state(account, entity)


@router.post("/entities/{entity}/generation-plans")
async def personal_prepare(
    entity: str, body: PersonalIntent, request: Request, account: User
) -> dict:
    return await request.app.state.services.media_jobs.personal.prepare(account, entity, body)


@router.post("/entities/{entity}/generation-plans/{plan}/confirm")
async def personal_confirm(
    entity: str, plan: str, body: ConfirmPlan, request: Request, account: User
) -> dict:
    return await request.app.state.services.media_jobs.personal.confirm(account, entity, plan, body)


@router.post("/entities/{entity}/adopt")
async def adopt(entity: str, body: PersonalAdopt, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.personal.adopt(account, entity, body)


@router.post("/jobs/{job}/actions")
async def decide(job: str, body: JobDecision, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.lifecycle.decide(account, job, body)


@router.get("/jobs/{job}/actions")
async def history(job: str, request: Request, account: User) -> list[dict]:
    return await request.app.state.services.media_jobs.lifecycle.history(account, job)


@router.post("/personal-media/{job}/access")
async def access(job: str, request: Request, response: Response, account: User) -> dict:
    await request.app.state.services.media_jobs.file(account, None, job)
    set_media_access(
        request,
        response,
        request.url_for("studio_personal_job", job=job).path,
        "studio-personal-job:" + job,
    )
    return {"ready": True}


@router.get("/personal-media/{job}", name="studio_personal_job")
async def media(job: str, request: Request) -> FileResponse:
    account = await media_account(request, "studio-personal-job:" + job)
    path, mime = await request.app.state.services.media_jobs.file(account, None, job)
    return FileResponse(
        path,
        media_type=mime,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )

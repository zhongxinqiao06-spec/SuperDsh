"""准备阶段的页面入口与导演工具调用同一领域服务。"""

from fastapi import APIRouter, Request

from app.modules.studio.controller.studio_controller import User
from app.modules.studio.entity.vo.preparation_vo import (
    AdoptPreparation,
    ConfirmStage,
    PreparationJob,
    ProposeDocument,
    ReviewFields,
    Stage,
)
from app.modules.studio.entity.vo.text_edit_vo import CreateTextEdit, ResolveTextEdit

router = APIRouter(prefix="/studio/projects/{project}", tags=["创作准备"])


@router.get("/text-edits")
async def text_edits(project: str, request: Request, account: User) -> list[dict]:
    """恢复当前作品的局部编辑建议与可撤回记录。"""
    return await request.app.state.services.studio.text_edits.list(account, project)


@router.post("/text-edits")
async def create_text_edit(
    project: str, body: CreateTextEdit, request: Request, account: User
) -> dict:
    return await request.app.state.services.studio.text_edits.create(account, project, body)


@router.post("/text-edits/{edit}/resolve")
async def resolve_text_edit(
    project: str, edit: str, body: ResolveTextEdit, request: Request, account: User
) -> dict:
    return await request.app.state.services.studio.text_edits.resolve(account, project, edit, body)


@router.get("/preparation")
async def preparation(project: str, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.preparation.state(account, project)


@router.post("/stages/{stage}/confirm")
async def confirm(
    project: str, stage: Stage, body: ConfirmStage, request: Request, account: User
) -> dict:
    return await request.app.state.services.studio.preparation.confirm(
        account, project, stage, body
    )


@router.post("/proposals")
async def propose(project: str, body: ProposeDocument, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.proposals.propose(account, project, body)


@router.get("/proposals/{proposal}")
async def compare(project: str, proposal: str, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.proposals.compare(account, project, proposal)


@router.post("/proposals/{proposal}/review")
async def review(
    project: str, proposal: str, body: ReviewFields, request: Request, account: User
) -> dict:
    return await request.app.state.services.studio.proposals.review(
        account, project, proposal, body
    )


@router.post("/preparation/jobs")
async def create_job(
    project: str, body: PreparationJob, request: Request, account: User, preview: bool = False
) -> dict:
    return await request.app.state.services.media_jobs.preparation.submit(
        account, project, body, preview=preview
    )


@router.post("/preparation/adopt")
async def adopt(project: str, body: AdoptPreparation, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.preparation.adopt(account, project, body)

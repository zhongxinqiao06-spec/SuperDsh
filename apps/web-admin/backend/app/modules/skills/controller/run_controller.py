"""会话技能与成果读取协议，所有状态推进只能来自可信执行用例。"""

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.entity.vo.plan_dto import PlanRevisionInput
from app.modules.skills.service.control_service import run_view

router = APIRouter(prefix="/sessions/{session_id}", tags=["skill-runs"])
AccountDep = Annotated[Account, Depends(current_account)]


async def authorize(request: Request, account: Account, session_id: str) -> None:
    """会话归属与成果阅读权限分别校验，不接受任意运行 ID 查详情。"""
    account.require("files.read")
    await request.app.state.services.conversations.get_session(account, session_id)


@router.get("/skill-runs")
async def runs(session_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    await authorize(request, account, session_id)
    values = await request.app.state.services.skills.listing(account, session_id)
    return {"items": [run_view(value) for value in values]}


@router.get("/plans")
async def plans(session_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    """读取会话真实工具方案，兼容入口只通过集中映射接入。"""
    await authorize(request, account, session_id)
    return await request.app.state.services.agent_execution.plans.listing(account, session_id)


@router.get("/plans/{plan_id}")
async def plan(
    session_id: str, plan_id: str, request: Request, account: AccountDep
) -> dict[str, object]:
    await authorize(request, account, session_id)
    service = request.app.state.services.agent_execution.plans
    return {"plan": service.view(await service.read(account, session_id, plan_id))}


@router.put("/plans/{plan_id}")
async def revise_plan(
    session_id: str, plan_id: str, body: PlanRevisionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    await authorize(request, account, session_id)
    return await request.app.state.services.agent_execution.plans.revise(
        account, session_id, plan_id, body
    )


@router.get("/evidence")
async def references(session_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    await authorize(request, account, session_id)
    return await request.app.state.services.agent_execution.references.listing(account, session_id)


@router.get("/evidence/{evidence_id}")
async def reference(
    session_id: str,
    evidence_id: str,
    request: Request,
    account: AccountDep,
    quote: str | None = None,
) -> dict[str, object]:
    await authorize(request, account, session_id)
    sources = await request.app.state.services.agent_execution.references.sources(
        account, session_id, evidence_id, quote
    )
    return {"source": sources[0]}


@router.get("/skill-runs/{run_id}")
async def read_run(
    session_id: str, run_id: str, request: Request, account: AccountDep
) -> dict[str, object]:
    await authorize(request, account, session_id)
    run = await request.app.state.services.skills.read(account, run_id)
    if run.session_id != session_id:
        raise DomainError(404, "skill run not found")
    return {"run": run_view(run)}


@router.get("/agent-artifacts")
async def artifacts(session_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    await authorize(request, account, session_id)
    return await request.app.state.services.evidence.listing(account, session_id)


@router.get("/agent-artifacts/{artifact_id}/download")
async def download(
    session_id: str, artifact_id: str, request: Request, account: AccountDep
) -> FileResponse:
    await authorize(request, account, session_id)
    artifact, path = await request.app.state.services.evidence.resolve_artifact(
        account, artifact_id
    )
    if artifact.session_id != session_id:
        raise DomainError(404, "artifact not found")
    return FileResponse(
        path,
        media_type=artifact.media_type,
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''"
            + quote(str(artifact.metadata_json.get("filename", path.name))),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/agent-artifacts/{artifact_id}/preview")
async def preview(
    session_id: str, artifact_id: str, request: Request, account: AccountDep
) -> dict[str, object]:
    await authorize(request, account, session_id)
    return await request.app.state.services.evidence.preview(account, session_id, artifact_id)

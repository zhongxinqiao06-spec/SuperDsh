"""项目、会话与历史查询 HTTP 边界，旧入口通过中央映射复用。"""

from typing import Annotated, cast

from fastapi import APIRouter, Body, Depends, Request

from app.api.dependencies import current_account
from app.modules.conversations.entity.vo.conversation_dto import (
    CreateSessionInput,
    MessageInput,
    ProjectInput,
)
from app.modules.conversations.entity.vo.import_dto import ImportSessionInput
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["conversations"])
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ConversationService:
    return cast(ConversationService, request.app.state.services.conversations)


@router.get("/projects")
async def projects(request: Request, account: AccountDep) -> object:
    return await service(request).projects.listing(account)


@router.post("/projects")
async def project_create(value: ProjectInput, request: Request, account: AccountDep) -> object:
    return await service(request).projects.create(account, value)


@router.patch("/projects/{project_id}")
async def project_update(
    project_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).projects.update(account, project_id, value)


@router.delete("/projects/{project_id}")
async def project_remove(project_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).projects.update(account, project_id, {}, True)


@router.get("/projects/{project_id}/sessions")
async def project_sessions(project_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).listing(
        account, {**dict(request.query_params), "projectId": project_id}
    )


@router.get("/sessions")
async def sessions(request: Request, account: AccountDep) -> object:
    return await service(request).listing(account, dict(request.query_params))


@router.get("/sessions/list")
async def inventory(request: Request, account: AccountDep) -> object:
    """旧清单契约为全部会话；分页页面调用/sessions，不能以首屏代替完整目录。"""
    return await service(request).listing(account, {}, inventory=True)


@router.post("/sessions")
async def create(value: ImportSessionInput, request: Request, account: AccountDep) -> object:
    return await service(request).imports.create(account, value)


@router.post("/sessions/create-and-start")
async def create_start(value: CreateSessionInput, request: Request, account: AccountDep) -> object:
    return await service(request).create(account, value)


@router.get("/sessions/{session_id}/meta")
async def meta(session_id: str, request: Request, account: AccountDep) -> object:
    return {"session": await service(request).get_session(account, session_id)}


@router.delete("/sessions/{session_id}")
async def remove(session_id: str, request: Request, account: AccountDep) -> object:
    """删除当前账号的历史记录；运行中的任务必须先终止。"""
    return await service(request).lifecycle.remove(account, session_id)


@router.patch("/sessions/{session_id}/meta")
async def update(
    session_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).update(account, session_id, value)


@router.post("/sessions/{action}")
async def batch(
    action: str, value: Annotated[object, Body()], request: Request, account: AccountDep
) -> object:
    return await service(request).batch.update(account, action, value)


@router.post("/projects/{target_id}/sessions/archive-all")
@router.post("/connectors/{target_id}/sessions/archive-all")
async def archive_all(
    target_id: str,
    request: Request,
    account: AccountDep,
    value: Annotated[dict[str, object] | None, Body()] = None,
) -> object:
    return await service(request).batch.archive_all(
        account, target_id, "/projects/" in request.url.path, value or {}
    )


@router.get("/sessions/{session_id}/snapshot")
async def snapshot(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).snapshot(account, session_id, dict(request.query_params))


@router.get("/sessions/{session_id}/timeline")
async def timeline(
    session_id: str,
    request: Request,
    account: AccountDep,
) -> object:
    return await service(request).timeline(account, session_id, dict(request.query_params))


@router.get("/sessions/{session_id}/events")
async def events(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).recover_events(account, session_id, dict(request.query_params))


@router.get("/sessions/{session_id}/agent-binding")
async def agent_binding(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).binding_view(account, session_id)


@router.put("/sessions/{session_id}/agent-binding")
async def bind_agent(
    session_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).bind_agent(
        account, session_id, str(value.get("agentDefinitionId", "")), value.get("bindingVersion")
    )


@router.post("/sessions/{session_id}/runtime/messages")
async def message(
    session_id: str, value: MessageInput, request: Request, account: AccountDep
) -> object:
    return await service(request).actions.message(account, session_id, value.model_dump())


@router.post("/sessions/{session_id}/runtime/interrupt")
async def interrupt(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).lifecycle.interrupt(account, session_id)


@router.post("/sessions/{session_id}/runtime/steer")
async def steer(
    session_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).actions.command(account, session_id, "steer", value)


@router.patch("/sessions/{session_id}/runtime/selections")
async def selections(
    session_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).actions.command(account, session_id, "selections", value)


@router.post("/sessions/{session_id}/runtime/notices/{notice_id}/respond")
async def respond(
    session_id: str, notice_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).actions.command(
        account,
        session_id,
        "notice",
        {**value, "noticeId": notice_id, "interactionId": value.get("interactionId", notice_id)},
    )


@router.post("/sessions/{session_id}/runtime/commands")
async def command(
    session_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).actions.command(account, session_id, "commands", value)


@router.post("/sessions/{session_id}/sync")
async def sync(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).actions.command(account, session_id, "sync", {})


@router.get("/sessions/{session_id}/runtime/state")
async def state(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).runtime_state(account, session_id)


@router.get("/sessions/{session_id}/runtime/capabilities")
async def capabilities(session_id: str, request: Request, account: AccountDep) -> object:
    return {"capabilitySet": await service(request).runtime_capabilities(account, session_id)}


@router.get("/sessions/{session_id}/runtime/notices")
async def notices(session_id: str, request: Request, account: AccountDep) -> object:
    return {"notices": (await service(request).own(account, session_id)).state.get("notices", [])}


@router.get("/sessions/{session_id}/runtime/catalogs/{kind}")
@router.get("/sessions/{session_id}/runtime/commands")
async def catalog(
    session_id: str, request: Request, account: AccountDep, kind: str = "commands"
) -> object:
    conversations = service(request)
    row = await conversations.own(account, session_id)
    return await conversations.devices.runtimes.catalog(
        account, row.connector_id, row.runtime_id, kind
    )


@router.post("/sessions/{session_id}/takeover")
async def takeover(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).update(account, session_id, {"takeover": True})


@router.delete("/sessions/{session_id}/takeover")
async def release_takeover(session_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).update(account, session_id, {"takeover": False})

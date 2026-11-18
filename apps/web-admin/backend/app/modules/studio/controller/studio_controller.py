"""星桥娱乐作品接口，所有工程、媒体读取与后台动作均复查产品权限。"""

import time
from typing import Annotated, Literal

from cryptography.exceptions import InvalidTag
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse

from app.api.dependencies import require_permission
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.controller.library_controller import router as library_router
from app.modules.studio.entity.vo.foundation_vo import ArchiveProject, CreateProject, UpdateBrief
from app.modules.studio.entity.vo.studio_vo import (
    AssetInput,
    Batch,
    Document,
    Identifier,
    NewProject,
    Review,
    SaveDocument,
)
from app.modules.studio.service.library_service import StudioLibraryService

router = APIRouter(prefix="/studio", tags=["星桥娱乐"])
User = Annotated[Account, Depends(require_permission("products.entertainment"))]


Page = Annotated[int, Query(ge=1, le=1_000_000)]
PageSize = Annotated[int, Query(ge=1, le=100)]
Search = Annotated[str, Query(max_length=120)]


@router.get("/defaults")
async def defaults(request: Request, account: User) -> dict:
    settings = await request.app.state.services.model_configurations.product_settings(
        account, "entertainment"
    )
    return settings["overrides"]


@router.put("/defaults/{capability}")
async def default(
    capability: str, request: Request, account: User, configuration: Identifier | None = None
) -> dict:
    return await request.app.state.services.model_configurations.set_product_default(
        account, "entertainment", capability, configuration
    )


@router.get("/catalog")
async def catalog(request: Request, account: User) -> dict:
    services = request.app.state.services
    models = await services.model_configurations.catalog(account, "entertainment")
    agents = (
        await services.resources.published_agents(account, "entertainment")
        if "sessions.run" in account.permissions
        else []
    )
    return {**models, "agents": agents}


@router.get("/projects")
async def projects(
    request: Request,
    account: User,
    page: Annotated[int | None, Query(ge=1, le=1_000_000)] = None,
    pageSize: PageSize = 10,
    search: Search = "",
    lifecycle: Literal["active", "archived"] = "active",
) -> list[dict] | dict:
    if page is not None:
        return await request.app.state.services.studio.project_page(
            account, page, pageSize, search.strip(), lifecycle
        )
    return await request.app.state.services.studio.list_projects(account)


@router.get("/library")
async def asset_directory(
    request: Request,
    account: User,
    page: Page = 1,
    pageSize: PageSize = 10,
    category: Literal["", "characters", "environments", "scenes", "props", "media"] = "",
    scope: Literal["personal", "project"] = "personal",
    kind: Literal["", "character", "scene", "prop", "image", "video", "audio", "music"] = "",
    search: Search = "",
    kinds: Annotated[str, Query(max_length=100)] = "",
    archived: bool = False,
) -> dict:
    selected = list(dict.fromkeys(value.strip() for value in kinds.split(",") if value.strip()))
    if set(selected) - {"character", "scene", "prop", "image", "video", "audio", "music"}:
        raise DomainError(422, "不支持的素材类型")
    return await StudioLibraryService(request.app.state.services.studio).page(
        account, page, pageSize, scope, kind, search.strip(), category, selected, archived
    )


@router.get("/library/{asset}/usage")
async def asset_usage(
    asset: str,
    request: Request,
    account: User,
    project: str | None = None,
    page: Page = 1,
    pageSize: PageSize = 10,
) -> dict:
    return await request.app.state.services.studio.usage(account, asset, project, page, pageSize)


@router.get("/jobs")
async def job_directory(
    request: Request,
    account: User,
    page: Page = 1,
    pageSize: PageSize = 10,
    state: Literal[
        "",
        "queued",
        "submitting",
        "polling",
        "downloading",
        "ready",
        "failed",
        "unknown",
        "paused",
        "cancelled",
        "unaccepted",
    ] = "",
    kind: Literal["", "video", "speech", "export", "image"] = "",
    search: Search = "",
) -> dict:
    return await request.app.state.services.studio.job_page(
        account, page, pageSize, state, kind, search.strip()
    )


@router.post("/projects")
async def create(body: CreateProject, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.foundation.create(account, body)


@router.get("/creation-defaults")
async def creation_defaults(request: Request, account: User) -> dict:
    return request.app.state.services.studio.foundation.preferences(account)


@router.patch("/projects/{project}")
async def update_brief(project: str, body: UpdateBrief, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.foundation.change(account, project, body)


@router.post("/projects/{project}/archive")
async def archive_project(
    project: str, body: ArchiveProject, request: Request, account: User
) -> dict:
    return await request.app.state.services.studio.foundation.change(account, project, body)


@router.get("/projects/{project}")
async def open_project(project: str, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.open(account, project)


@router.put("/projects/{project}")
async def save(project: str, body: SaveDocument, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.save(account, project, body)


@router.post("/projects/{project}/revisions/{version}/restore")
async def restore(
    project: str, version: int, revision: int, request: Request, account: User
) -> dict:
    if version < 1:
        raise DomainError(422, "无效的工程版本")
    return await request.app.state.services.studio.save(
        account, project, SaveDocument(revision=revision, document=Document()), version
    )


@router.post("/projects/{project}/proposal/review")
async def review(project: str, body: Review, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.review(account, project, body)


@router.get("/assets")
async def library(request: Request, account: User) -> list[dict]:
    return await request.app.state.services.studio.library(account)


@router.post("/assets")
async def asset(body: AssetInput, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.asset(account, body)


@router.post("/projects/{project}/assets/{asset}/link")
async def link_asset(project: str, asset: str, request: Request, account: User) -> dict:
    return await request.app.state.services.studio.link_asset(account, project, asset)


@router.post("/projects/{project}/conversation")
async def conversation(
    project: str,
    request: Request,
    account: User,
    agent: Identifier | None = None,
    purpose: Literal["director", "text-edit"] = "director",
) -> dict:
    return {
        "sessionId": await request.app.state.services.studio_agent.conversation(
            account, project, agent, text_edit=purpose == "text-edit"
        )
    }


@router.get("/projects/{project}/conversation/runtime")
async def director_runtime(
    project: str,
    request: Request,
    account: User,
    purpose: Literal["director", "text-edit"] = "director",
) -> dict:
    return await request.app.state.services.studio_agent.runtime_status(
        account, project, prepare=False, text_edit=purpose == "text-edit"
    )


@router.post("/projects/{project}/conversation/runtime")
async def prepare_director_runtime(
    project: str,
    request: Request,
    account: User,
    purpose: Literal["director", "text-edit"] = "director",
) -> dict:
    return await request.app.state.services.studio_agent.runtime_status(
        account, project, prepare=True, text_edit=purpose == "text-edit"
    )


@router.post("/projects/{project}/conversation/refresh")
async def refresh_director_tools(
    project: str,
    request: Request,
    account: User,
    agentDefinitionId: Identifier | None = None,
    purpose: Literal["director", "text-edit"] = "director",
) -> dict:
    return await request.app.state.services.studio_agent.refresh_conversation(
        account, project, agentDefinitionId, text_edit=purpose == "text-edit"
    )


@router.post("/projects/{project}/jobs")
async def submit(project: str, body: Batch, request: Request, account: User) -> list[dict]:
    return await request.app.state.services.media_jobs.submit(account, project, body)


@router.post("/projects/{project}/jobs/{job}/recover")
async def recover(project: str, job: str, request: Request, account: User) -> dict:
    return await request.app.state.services.media_jobs.recover(account, project, job)


@router.post("/projects/{project}/media/{job}/collect")
async def collect(
    project: str, job: str, body: NewProject, request: Request, account: User
) -> dict:
    return await request.app.state.services.media_jobs.collect(account, project, job, body.title)


def set_media_access(request: Request, response: Response, path: str, scope: str) -> None:
    lifetime = 600
    sealed = request.app.state.services.media_jobs.cipher.seal(
        f"{int(time.time()) + lifetime}:{request.headers['authorization'][7:]}", scope
    )
    response.set_cookie(
        "studio_media",
        sealed,
        max_age=lifetime,
        path=path,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
    )


async def media_account(request: Request, scope: str) -> Account:
    services = request.app.state.services
    try:
        sealed = services.media_jobs.cipher.open(request.cookies.get("studio_media", ""), scope)
        deadline, token = sealed.split(":", 1)
        if int(deadline) <= time.time():
            raise ValueError("expired")
    except (InvalidTag, ValueError, DomainError):
        raise DomainError(401, "媒体授权已失效") from None
    return await services.identity.authenticate(token)


@router.post("/projects/{project}/assets/{asset}/access")
async def asset_access(
    project: str, asset: str, request: Request, response: Response, account: User
) -> dict:
    await request.app.state.services.studio.asset_file(account, project, asset)
    path = request.url_for("studio_asset_file", project=project, asset=asset).path
    set_media_access(request, response, path, "studio-asset:" + project + ":" + asset)
    return {"ready": True}


@router.get("/projects/{project}/assets/{asset}", name="studio_asset_file")
async def asset_content(project: str, asset: str, request: Request) -> StreamingResponse:
    account = await media_account(request, "studio-asset:" + project + ":" + asset)
    return await stream_asset(request, account, project, asset)


@router.post("/assets/{asset}/access")
async def personal_access(asset: str, request: Request, response: Response, account: User) -> dict:
    await request.app.state.services.studio.asset_file(account, None, asset)
    set_media_access(
        request,
        response,
        request.url_for("studio_personal_file", asset=asset).path,
        "studio-personal:" + asset,
    )
    return {"ready": True}


@router.get("/assets/{asset}/content", name="studio_personal_file")
async def personal_content(asset: str, request: Request) -> StreamingResponse:
    account = await media_account(request, "studio-personal:" + asset)
    return await stream_asset(request, account, None, asset)


async def stream_asset(
    request: Request, account: Account, project: str | None, asset: str
) -> StreamingResponse:
    services = request.app.state.services
    file_id = await services.studio.asset_file(account, project, asset)
    data, info, span = await services.files.stream(account, file_id, request.headers.get("range"))
    size = int(info["size"])
    headers = {
        "Cache-Control": "private, no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": str(span[1] - span[0] + 1 if span else size),
    }
    if span:
        headers["Content-Range"] = f"bytes {span[0]}-{span[1]}/{size}"
    return StreamingResponse(
        data, status_code=206 if span else 200, media_type=info["mediaType"], headers=headers
    )


@router.post("/projects/{project}/media/{job}/access")
async def preview_access(
    project: str, job: str, request: Request, response: Response, account: User
) -> dict:
    """媒体元素的 Range 请求使用限定至本文件的短期 HttpOnly Cookie。"""
    services = request.app.state.services
    await services.media_jobs.file(account, project, job)
    path = str(request.url_for("studio_media", project=project, job=job).path)
    set_media_access(request, response, path, "studio-media:" + project + ":" + job)
    return {"ready": True}


@router.get("/projects/{project}/media/{job}", name="studio_media")
async def media(
    project: str, job: str, request: Request, download: bool = Query(False)
) -> FileResponse:
    services = request.app.state.services
    account = await media_account(request, "studio-media:" + project + ":" + job)
    path, mime = await services.media_jobs.file(account, project, job)
    return FileResponse(
        path,
        media_type=mime,
        filename=path.name if download else None,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


router.include_router(library_router)

"""系列短剧接口只负责授权入口与协议转换，领域修改统一交给 service。"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import require_permission
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.entity.vo.foundation_vo import ArchiveProject
from app.modules.studio.entity.vo.series_vo import (
    ApplySeriesSettings,
    ConfirmEpisode,
    ConfirmStructurePlan,
    CreateEpisode,
    CreateSeries,
    CreateSeriesProposal,
    ImportEpisode,
    LockEpisode,
    RemoveEpisode,
    ReorderEpisodes,
    ResolveSeriesProposal,
    SeriesSettings,
    StructurePlanInput,
    UpdateEpisode,
    UpdateSeries,
)
from app.modules.studio.service.series_proposal_service import SeriesProposalService
from app.modules.studio.service.series_service import SeriesService
from app.modules.studio.service.series_settings_service import SeriesSettingsService
from app.modules.studio.service.series_structure_service import SeriesStructureService
from app.modules.studio.service.work_directory_service import WorkDirectoryService

router = APIRouter(prefix="/studio", tags=["系列短剧"])
User = Annotated[Account, Depends(require_permission("products.entertainment"))]


def service(request: Request) -> SeriesService:
    return SeriesService(request.app.state.services.studio)


@router.get("/works")
async def works(
    request: Request,
    account: User,
    page: Annotated[int, Query(ge=1, le=1_000_000)] = 1,
    pageSize: Annotated[int, Query(ge=1, le=100)] = 10,
    search: Annotated[str, Query(max_length=120)] = "",
    lifecycle: Literal["active", "archived"] = "active",
    mode: Literal["all", "quick", "storyboard", "series"] = "all",
) -> dict:
    return await WorkDirectoryService(service(request)).page(
        account, mode, lifecycle, search.strip(), page, pageSize
    )


@router.get("/series")
async def series_page(
    request: Request,
    account: User,
    page: Annotated[int, Query(ge=1, le=1_000_000)] = 1,
    pageSize: Annotated[int, Query(ge=1, le=100)] = 10,
    search: Annotated[str, Query(max_length=120)] = "",
    lifecycle: Literal["active", "archived"] = "active",
) -> dict:
    return await WorkDirectoryService(service(request)).page(
        account, "series", lifecycle, search.strip(), page, pageSize
    )


@router.post("/series")
async def create_series(body: CreateSeries, request: Request, account: User) -> dict:
    return await service(request).create(account, body)


@router.get("/series/{series_id}")
async def get_series(series_id: str, request: Request, account: User) -> dict:
    return await service(request).get(account, series_id)


@router.patch("/series/{series_id}")
async def update_series(
    series_id: str, body: UpdateSeries, request: Request, account: User
) -> dict:
    return await service(request).update(account, series_id, body)


@router.post("/series/{series_id}/archive")
async def archive_series(
    series_id: str, body: ArchiveProject, request: Request, account: User
) -> dict:
    return await service(request).update(account, series_id, body)


@router.post("/series/{series_id}/episodes")
async def create_episode(
    series_id: str, body: CreateEpisode, request: Request, account: User
) -> dict:
    return await service(request).create_episode(account, series_id, body)


@router.patch("/series/{series_id}/episodes/{episode_id}")
async def update_episode(
    series_id: str, episode_id: str, body: UpdateEpisode, request: Request, account: User
) -> dict:
    return await service(request).mutate_episode(account, series_id, episode_id, body)


@router.post("/series/{series_id}/episodes/{episode_id}/confirm")
async def confirm_episode(
    series_id: str, episode_id: str, body: ConfirmEpisode, request: Request, account: User
) -> dict:
    return await service(request).mutate_episode(account, series_id, episode_id, body)


@router.post("/series/{series_id}/episodes/{episode_id}/lock")
async def lock_episode(
    series_id: str, episode_id: str, body: LockEpisode, request: Request, account: User
) -> dict:
    return await service(request).mutate_episode(account, series_id, episode_id, body)


@router.put("/series/{series_id}/order")
async def reorder_episodes(
    series_id: str, body: ReorderEpisodes, request: Request, account: User
) -> dict:
    return await service(request).reorder(account, series_id, body)


@router.put("/series/{series_id}/settings")
async def update_settings(
    series_id: str, body: SeriesSettings, request: Request, account: User
) -> dict:
    return await SeriesSettingsService(service(request)).update(account, series_id, body)


@router.post("/series/{series_id}/settings/apply")
async def apply_settings(
    series_id: str, body: ApplySeriesSettings, request: Request, account: User
) -> dict:
    return await SeriesSettingsService(service(request)).apply(account, series_id, body)


@router.get("/projects/{project_id}/episode-context")
async def episode_context(project_id: str, request: Request, account: User) -> dict | None:
    return await service(request).context(account, project_id)


@router.get("/series/{series_id}/proposals")
async def list_proposals(series_id: str, request: Request, account: User) -> list[dict]:
    return await SeriesProposalService(service(request)).list(account, series_id)


@router.post("/series/{series_id}/proposals")
async def create_proposal(
    series_id: str, body: CreateSeriesProposal, request: Request, account: User
) -> dict:
    return await SeriesProposalService(service(request)).create(account, series_id, body)


@router.post("/series/{series_id}/proposals/{proposal_id}/resolve")
async def resolve_proposal(
    series_id: str, proposal_id: str, body: ResolveSeriesProposal, request: Request, account: User
) -> dict:
    return await SeriesProposalService(service(request)).resolve(
        account, series_id, proposal_id, body
    )


@router.post("/series/{series_id}/episodes/{episode_id}/remove")
async def remove_episode(
    series_id: str, episode_id: str, body: RemoveEpisode, request: Request, account: User
) -> dict:
    return await SeriesStructureService(service(request)).remove(
        account, series_id, episode_id, body
    )


@router.post("/series/{series_id}/import-episode")
async def import_episode(
    series_id: str, body: ImportEpisode, request: Request, account: User
) -> dict:
    return await SeriesStructureService(service(request)).import_episode(account, series_id, body)


@router.post("/series/{series_id}/structure-plans")
async def preview_structure(
    series_id: str, body: StructurePlanInput, request: Request, account: User
) -> dict:
    return await SeriesStructureService(service(request)).preview(account, series_id, body)


@router.post("/series/{series_id}/structure-plans/{plan_id}/confirm")
async def confirm_structure(
    series_id: str, plan_id: str, body: ConfirmStructurePlan, request: Request, account: User
) -> dict:
    return await SeriesStructureService(service(request)).confirm(account, series_id, plan_id, body)

"""素材库交互接口只负责输入与用例转发，归属、并发及事务由服务层复核。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.api.dependencies import require_permission
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.entity.vo.library_vo import (
    ApplyLibraryUpdate,
    ArchiveLibrary,
    CollectLibrary,
    ImportLibrary,
    PreviewLibraryUpdate,
)
from app.modules.studio.service.library_service import StudioLibraryService
from app.modules.studio.service.library_update_service import LibraryUpdateService

router = APIRouter()
User = Annotated[Account, Depends(require_permission("products.entertainment"))]


def service(request: Request) -> StudioLibraryService:
    services = request.app.state.services
    return StudioLibraryService(services.studio, services.media_jobs)


@router.get("/library/{asset}/detail")
async def detail(asset: str, request: Request, account: User) -> dict:
    return await service(request).detail(account, asset)


@router.post("/library/collections")
async def collect(body: CollectLibrary, request: Request, account: User) -> dict:
    return await service(request).collect(account, body)


@router.post("/library/{asset}/archive")
async def archive(asset: str, body: ArchiveLibrary, request: Request, account: User) -> dict:
    return await service(request).archive(account, asset, body)


@router.post("/projects/{project}/library-imports")
async def import_version(
    project: str, body: ImportLibrary, request: Request, account: User
) -> dict:
    return await service(request).import_version(account, project, body)


@router.post("/projects/{project}/library-updates/preview")
async def preview_update(
    project: str, body: PreviewLibraryUpdate, request: Request, account: User
) -> dict:
    return await LibraryUpdateService(service(request)).preview(account, project, body)


@router.post("/projects/{project}/library-updates/apply")
async def apply_update(
    project: str, body: ApplyLibraryUpdate, request: Request, account: User
) -> dict:
    return await LibraryUpdateService(service(request)).apply(account, project, body)

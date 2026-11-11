"""文件 HTTP 协议层，只转换输入输出并调用文件服务。"""

from typing import Annotated, cast
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from starlette.responses import Response

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.files.entity.vo.file_dto import ConnectionInput, SettingsInput, UploadInput
from app.modules.files.service.content import byte_range
from app.modules.files.service.file_service import FileService
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["files"])
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> FileService:
    """读取应用注入的服务，路由不接触存储或 DAO。"""
    return cast(FileService, request.app.state.services.files)


@router.get("/files")
async def listing(
    request: Request,
    account: AccountDep,
    page: Annotated[int, Query(ge=1)] = 1,
    pageSize: Annotated[int, Query(ge=1, le=100)] = 10,
    search: str = "",
    category: str = "",
    deleted: bool = False,
    q: str | None = None,
    trash: bool | None = None,
) -> dict[str, object]:
    return await service(request).list_entries(
        account,
        {
            "page": page,
            "pageSize": pageSize,
            "search": q if q is not None else search,
            "category": category,
            "deleted": trash if trash is not None else deleted,
        },
    )


@router.post("/files/uploads")
async def begin(body: UploadInput, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).uploads.begin(account, body)


@router.get("/files/uploads/{upload_id}")
async def upload_status(upload_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).uploads.status(account, upload_id)


@router.put("/files/uploads/{upload_id}/parts/{part}")
async def upload_part(
    upload_id: str, part: int, request: Request, account: AccountDep
) -> dict[str, object]:
    account.require("files.write")
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 8 * 1024 * 1024:
            raise DomainError(413, "上传分片过大")
    return await service(request).uploads.part(account, upload_id, part, bytes(content))


@router.post("/files/uploads/{upload_id}/complete")
async def complete(upload_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).uploads.complete(account, upload_id)


@router.post("/files/uploads/{upload_id}/cancel")
async def cancel(upload_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).uploads.cancel(account, upload_id)


@router.get("/files/{file_id}")
async def entry(file_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).entry(account, file_id)


@router.get("/files/{file_id}/content")
async def content(
    file_id: str, request: Request, account: AccountDep, inline: bool = False
) -> Response:
    data, info = await service(request).read(account, file_id)
    span = byte_range(request.headers.get("range"), len(data))
    media = str(info["mediaType"])
    safe_inline = inline and (
        media.startswith(
            ("image/png", "image/jpeg", "image/webp", "image/gif", "audio/", "video/", "text/plain")
        )
        or media == "application/pdf"
    )
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": ("inline" if safe_inline else "attachment")
        + "; filename*=UTF-8''"
        + quote(str(info["name"])),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
    }
    if span:
        headers["Content-Range"] = f"bytes {span[0]}-{span[1]}/{len(data)}"
        data = data[span[0] : span[1] + 1]
    return Response(data, status_code=206 if span else 200, media_type=media, headers=headers)


@router.get("/files/{file_id}/versions")
async def versions(file_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).versions(account, file_id)


@router.post("/files/{file_id}/trash")
async def trash(file_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).trash(account, file_id)


@router.post("/files/{file_id}/restore")
async def restore(file_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).trash(account, file_id, True)


@router.get("/admin/storage")
async def storage(request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).storage.settings(account)


@router.put("/admin/storage")
async def update_storage(
    body: SettingsInput, request: Request, account: AccountDep
) -> dict[str, object]:
    return await service(request).storage.update(account, body)


@router.post("/admin/storage/connections")
async def create_connection(
    body: ConnectionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    return await service(request).storage.save(account, body)


@router.patch("/admin/storage/connections/{connection_id}")
async def update_connection(
    connection_id: str, body: ConnectionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    return await service(request).storage.save(account, body, connection_id)


@router.post("/admin/storage/connections/{connection_id}/check")
async def check_connection(
    connection_id: str, request: Request, account: AccountDep
) -> dict[str, object]:
    return await service(request).storage.check(account, connection_id)


@router.get("/admin/storage/usage")
async def usage(request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).maintenance.usage(account)


@router.get("/admin/storage/migrations")
async def migrations(request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).maintenance.listing(account)


@router.post("/admin/storage/cleanup")
async def cleanup(request: Request, account: AccountDep) -> dict[str, object]:
    return await service(request).maintenance.cleanup(account)


@router.post("/files/{file_id}/migrate")
async def migrate(
    file_id: str, body: dict[str, object], request: Request, account: AccountDep
) -> dict[str, object]:
    return await service(request).maintenance.migrate(
        account, file_id, str(body.get("targetStorageId", body.get("storageId", "")))
    )

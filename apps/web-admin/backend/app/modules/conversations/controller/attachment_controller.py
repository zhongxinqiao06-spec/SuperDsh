"""会话附件与分享下载，仅发布已授权文件库内容。"""

import base64
import binascii
from datetime import UTC, datetime
from typing import Annotated, cast
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, Request, Response

from app.api.dependencies import current_account
from app.api.multipart import attachment_parts
from app.infrastructure.errors import DomainError
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.files.service.content import byte_range
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["conversation-files"])
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ConversationService:
    return cast(ConversationService, request.app.state.services.conversations)


def attachment_links(
    request: Request, session_id: str, entry: dict[str, object]
) -> dict[str, object]:
    """返回链接根据集中映射选择原入口，不在业务服务拼接兼容版本路径。"""
    canonical = f"/api/sessions/{quote(session_id, safe='')}/attachments/{quote(str(entry['fileId']), safe='')}"
    catalog = request.app.state.compatibility
    return {
        **entry,
        "downloadUrl": catalog.outward(request.scope, canonical),
        "openUrl": catalog.outward(request.scope, canonical + "/open"),
    }


def content_response(
    data: bytes, entry: dict[str, object], range_header: str | None = None, inline: bool = False
) -> Response:
    """附件默认下载并限制活动内容，避免文件名进入响应头语法。"""
    media = str(entry["mediaType"])
    safe_inline = inline and media in {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
        "application/pdf",
        "text/plain",
    }
    span = byte_range(range_header, len(data))
    headers = {
        "Content-Disposition": f"{'inline' if safe_inline else 'attachment'}; filename*=UTF-8''{quote(str(entry['name']))}",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
        "Accept-Ranges": "bytes",
    }
    if span:
        headers["Content-Range"] = f"bytes {span[0]}-{span[1]}/{len(data)}"
        data = data[span[0] : span[1] + 1]
    return Response(
        data,
        status_code=206 if span else 200,
        media_type=media,
        headers=headers,
    )


@router.post("/sessions/{session_id}/attachments")
async def upload(session_id: str, request: Request, account: AccountDep) -> object:
    conversations = service(request)
    await conversations.get_session(account, session_id)
    account.require("files.write")
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        parts = attachment_parts(request.headers["content-type"], await request.body())
        return {
            "attachments": [
                attachment_links(
                    request,
                    session_id,
                    await conversations.attachments.upload(
                        account, session_id, part.name, part.content, part.media_type
                    ),
                )
                for part in parts
            ],
            "serverTime": datetime.now(UTC).isoformat(),
        }
    # 新前端已有的JSON小文件上传仍可使用；旧multipart入口不再被DTO拒绝。
    try:
        value = await request.json()
    except ValueError as error:
        raise DomainError(422, "invalid attachment input") from error
    if not isinstance(value, dict):
        raise DomainError(422, "invalid attachment input")
    encoded = value.get("contentBase64", value.get("dataBase64"))
    if not isinstance(encoded, str) or len(encoded) > 48 * 1024 * 1024:
        raise DomainError(413, "attachment too large or invalid")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise DomainError(422, "invalid attachment encoding") from error
    entry = await conversations.attachments.upload(
        account,
        session_id,
        str(value.get("name", "attachment")),
        data,
        str(value.get("mediaType", "application/octet-stream")),
    )
    return {"attachment": attachment_links(request, session_id, entry)}


@router.post("/sessions/{session_id}/attachments/from-file")
async def bind(
    session_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    result = await service(request).attachments.bind(
        account, session_id, str(value.get("fileId", ""))
    )
    entry = result["attachment"]
    assert isinstance(entry, dict)
    return {**result, "attachment": attachment_links(request, session_id, entry)}


@router.get("/sessions/{session_id}/attachments/{file_id}")
async def read(session_id: str, file_id: str, request: Request, account: AccountDep) -> object:
    """现有桌面/安卓下载接口返回JSON和Base64，原生媒体通过open短期地址读取。"""
    content, metadata = await service(request).attachments.read(account, session_id, file_id)
    return {
        **metadata,
        "contentBase64": base64.b64encode(content).decode(),
        "serverTime": datetime.now(UTC).isoformat(),
    }


@router.get("/sessions/{session_id}/attachments/{file_id}/open")
async def open_attachment(
    session_id: str, file_id: str, request: Request, token: str = ""
) -> Response:
    """原访问凭据只用于换取受限短期地址，不透传到重定向目标。"""
    credential = request.headers.get("authorization", "").removeprefix("Bearer ") or token
    access = await service(request).attachments.issue(credential, session_id, file_id)
    canonical = f"/api/sessions/local/{quote(session_id, safe='')}/{quote(file_id, safe='')}"
    target = request.app.state.compatibility.outward(request.scope, canonical)
    return Response(
        status_code=302,
        headers={"Location": f"{target}?token={quote(access)}", "Referrer-Policy": "no-referrer"},
    )


@router.get("/sessions/local/{session_id}/{file_id}")
async def local_attachment(
    session_id: str, file_id: str, request: Request, token: str = ""
) -> Response:
    """派生下载仍核验原登录会话，支持原客户端的Range续读。"""
    content, metadata = await service(request).attachments.download(token, session_id, file_id)
    return content_response(content, metadata, request.headers.get("range"), True)


@router.get("/connector/sessions/{session_id}/attachments/{file_id}/content")
async def connector_read(session_id: str, file_id: str, request: Request) -> Response:
    conversations = service(request)
    device = await conversations.devices.authenticate(
        request.headers.get("authorization", "").removeprefix("Bearer ")
    )
    account = await conversations.devices.identity.get_account(device.owner_id)
    session = await conversations.get_session(account, session_id)
    if session["connectorId"] != device.id:
        raise DomainError(404, "attachment not found")
    return content_response(
        *(await conversations.files.read_bound(account, file_id, "session", session_id))
    )


@router.post("/sessions/{session_id}/shares", status_code=201)
async def share(
    session_id: str,
    request: Request,
    account: AccountDep,
    value: Annotated[dict[str, object] | None, Body()] = None,
) -> object:
    return await service(request).sharing.create(
        account, session_id, value, request.app.state.settings.public_origin
    )


@router.get("/sessions/{session_id}/shares")
async def shares(session_id: str, request: Request, account: AccountDep) -> object:
    """会话所有者读取历史分享，刷新页面后仍能撤销。"""
    return await service(request).sharing.listing(account, session_id)


@router.delete("/shares/{share_id}")
async def revoke_share(share_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).sharing.revoke(account, share_id)


@router.get("/public/shares/{share_id}")
async def public_share(share_id: str, request: Request) -> object:
    return await service(request).sharing.get(share_id)


@router.get("/public/shares/{share_id}/attachments/{file_id}")
async def public_attachment(share_id: str, file_id: str, request: Request) -> Response:
    return content_response(*(await service(request).sharing.attachment(share_id, file_id)))

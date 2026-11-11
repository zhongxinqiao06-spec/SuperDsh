"""设备、配对和运行实例 HTTP 边界，只调用公开业务服务。"""

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Query, Request, Response, WebSocket

from app.api.dependencies import current_account
from app.api.websocket_response import reject_socket
from app.infrastructure.errors import DomainError
from app.infrastructure.query_parameters import query_integer
from app.modules.devices.entity.vo.device_dto import (
    DeviceInput,
    DevicePatch,
    FileRequest,
    PairingClaim,
    PairingPoll,
    PairingStart,
    RuntimeInput,
)
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account

router = APIRouter(tags=["devices"])
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request | WebSocket) -> DeviceService:
    return cast(DeviceService, request.app.state.services.devices)


@router.get("/connectors")
async def listing(request: Request, account: AccountDep) -> object:
    return await service(request).listing(account)


@router.post("/connectors")
async def create(value: DeviceInput, request: Request, account: AccountDep) -> object:
    return await service(request).create(account, value)


@router.get("/connectors/{connector_id}")
async def get(connector_id: str, request: Request, account: AccountDep) -> object:
    devices = service(request)
    return {"connector": devices.view(await devices.own(account, connector_id))}


@router.patch("/connectors/{connector_id}")
async def update(
    connector_id: str, value: DevicePatch, request: Request, account: AccountDep
) -> object:
    return await service(request).update(account, connector_id, value.name)


@router.delete("/connectors/{connector_id}")
async def remove(connector_id: str, request: Request, account: AccountDep) -> Response:
    """删除设备身份，已删除安装不能通过重新注册复活。"""
    await service(request).revoke(account, connector_id)
    return Response(status_code=204)


@router.post("/connectors/{connector_id}/revoke")
async def rotate(connector_id: str, request: Request, account: AccountDep) -> object:
    """撤销旧凭据并生成新的连接凭据，保持设备和会话身份。"""
    return await service(request).rotate(account, connector_id)


@router.get("/connectors/{connector_id}/preferences")
async def preferences(connector_id: str, request: Request, account: AccountDep) -> object:
    return {"preferences": (await service(request).own(account, connector_id)).preferences}


@router.get("/admin/devices")
async def inventory(
    request: Request,
    account: AccountDep,
    page: str | None = Query(None),
    pageSize: str | None = Query(None),
    search: str = "",
) -> object:
    return await service(request).listing(
        account, True, query_integer(page, 1, 1), query_integer(pageSize, 200, 1, 200), search
    )


@router.post("/admin/devices/{connector_id}/block")
async def block(
    connector_id: str, value: dict[str, object], request: Request, account: AccountDep
) -> object:
    return await service(request).block(account, connector_id, True, str(value.get("reason", "")))


@router.post("/admin/devices/{connector_id}/resume")
async def resume(connector_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).block(account, connector_id, False)


@router.post("/pairing/start")
async def pairing_start(value: PairingStart, request: Request) -> object:
    return await service(request).pairing.start(value)


@router.post("/pairing/claim")
async def pairing_claim(value: PairingClaim, request: Request, account: AccountDep) -> object:
    devices = service(request)
    return {
        "status": "claimed",
        "connector": devices.view(await devices.pairing.claim(account, value)),
    }


@router.post("/pairing/poll")
async def pairing_poll(value: PairingPoll, request: Request) -> object:
    return await service(request).pairing.poll(value.pairingId)


@router.post("/connector/auth")
async def connector_auth(request: Request) -> object:
    return await service(request).auth(request.headers.get("authorization", ""))


@router.post("/connector/ingest")
async def ingest(value: dict[str, object], request: Request) -> object:
    return await service(request).ingest(
        request.headers.get("authorization", "").removeprefix("Bearer "), value
    )


@router.websocket("/connector/ws")
async def connector_ws(socket: WebSocket) -> None:
    devices = service(socket)
    token = socket.headers.get("authorization", "").removeprefix(
        "Bearer "
    ) or socket.query_params.get("access_token", "")
    try:
        row = await devices.authenticate(token)
        await devices.channel.serve(
            row.id,
            socket,
            lambda method, params: devices.notify(row, method, params),
            lambda: devices.authenticate(token),
        )
    except DomainError as error:
        await reject_socket(socket, error)


@router.get("/connectors/{connector_id}/runtimes")
async def runtimes(connector_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).runtimes.listing(account, connector_id)


@router.get("/connectors/{connector_id}/runtime-types")
async def runtime_types(connector_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).runtimes.listing(account, connector_id, True)


@router.post("/connectors/{connector_id}/runtimes/discover")
async def discover(connector_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).runtimes.listing(account, connector_id, False, True)


@router.post("/connectors/{connector_id}/runtime-types/discover")
async def discover_types(connector_id: str, request: Request, account: AccountDep) -> object:
    return await service(request).runtimes.listing(account, connector_id, True, True)


@router.post("/connectors/{connector_id}/runtimes")
async def create_runtime(
    connector_id: str, value: RuntimeInput, request: Request, account: AccountDep
) -> object:
    return await service(request).runtimes.create(account, connector_id, value)


@router.get("/connectors/{connector_id}/runtimes/{runtime_id}")
async def runtime_get(
    connector_id: str, runtime_id: str, request: Request, account: AccountDep
) -> object:
    return await service(request).runtimes.get(account, connector_id, runtime_id)


@router.patch("/connectors/{connector_id}/runtimes/{runtime_id}")
async def runtime_patch(
    connector_id: str,
    runtime_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    return await service(request).runtimes.mutate(account, connector_id, runtime_id, "patch", value)


@router.put("/connectors/{connector_id}/runtimes/{runtime_id}/config")
async def runtime_config(
    connector_id: str,
    runtime_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    return await service(request).runtimes.mutate(
        account, connector_id, runtime_id, "config", value
    )


@router.delete("/connectors/{connector_id}/runtimes/{runtime_id}/config")
async def runtime_clear_config(
    connector_id: str, runtime_id: str, request: Request, account: AccountDep
) -> object:
    return await service(request).runtimes.mutate(
        account, connector_id, runtime_id, "clear-config", {}
    )


@router.put("/connectors/{connector_id}/runtimes/{runtime_id}/active")
async def runtime_active(
    connector_id: str,
    runtime_id: str,
    value: dict[str, object],
    request: Request,
    account: AccountDep,
) -> object:
    return await service(request).runtimes.mutate(
        account, connector_id, runtime_id, "active", value
    )


@router.get("/connectors/{connector_id}/runtimes/{runtime_id}/catalogs/{kind}")
async def catalog(
    connector_id: str, runtime_id: str, kind: str, request: Request, account: AccountDep
) -> object:
    return await service(request).runtimes.catalog(account, connector_id, runtime_id, kind)


@router.get("/connectors/{connector_id}/runtimes/{runtime_id}/capabilities")
async def capabilities(
    connector_id: str, runtime_id: str, request: Request, account: AccountDep
) -> object:
    return await service(request).runtimes.catalog(
        account, connector_id, runtime_id, "capabilities"
    )


@router.get("/connectors/{connector_id}/runtimes/{runtime_id}/commands")
async def commands(
    connector_id: str, runtime_id: str, request: Request, account: AccountDep
) -> object:
    return await service(request).runtimes.catalog(account, connector_id, runtime_id, "commands")


@router.post("/connectors/{connector_id}/fs/list")
@router.post("/connectors/{connector_id}/fs/readText")
@router.post("/connectors/{connector_id}/fs/write")
async def files(
    connector_id: str,
    value: FileRequest,
    request: Request,
    account: AccountDep,
    root: str | None = None,
) -> object:
    action = request.url.path.rsplit("/", 1)[-1]
    if root is not None:
        value = value.model_copy(update={"root": root})
    return await service(request).files.execute(account, connector_id, action, value)

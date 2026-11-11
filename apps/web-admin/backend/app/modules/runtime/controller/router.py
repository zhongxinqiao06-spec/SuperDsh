"""P1 运行准备和真实协议诊断入口；完整会话产品接口继续由业务迁移完成。"""

from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account, require_permission
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.runtime.entity.bo.values import Fields, Json
from app.modules.runtime.entity.vo.runtime import SessionMessage
from app.modules.runtime.service.runtime import RuntimeService

router = APIRouter(tags=["runtime"])
CurrentAccount = Annotated[Account, Depends(current_account)]
RunnerAccount = Annotated[Account, Depends(require_permission("sessions.run"))]
ManagerAccount = Annotated[Account, Depends(require_permission("devices.manage"))]


def service(request: Request) -> RuntimeService:
    """从应用装配读取运行用例，不在路由创建监督器或数据库。"""
    return cast(RuntimeService, request.app.state.services.runtime)


@router.get("/server-agent", response_model=None)
async def status(request: Request, account: CurrentAccount) -> Fields:
    """查询自身状态没有启动副作用。"""
    return {
        "agent": await service(request).view(account.user_id),
        "serverTime": datetime.now(UTC).isoformat(),
    }


@router.post("/server-agent", response_model=None)
async def prepare(request: Request, account: ManagerAccount) -> Fields:
    """工作台显式准备入口，未就绪时返回 starting 而非虚假 running。"""
    return {
        "agent": await service(request).prepare(account.user_id),
        "serverTime": datetime.now(UTC).isoformat(),
    }


@router.delete("/server-agent", response_model=None)
async def stop(request: Request, account: ManagerAccount) -> Fields:
    """停止自身实例并等待回收，不能操作其他用户进程。"""
    await service(request).stop(account.user_id)
    return {"ok": True}


@router.get("/runtime/catalogs/{kind}", response_model=None)
async def catalog(kind: str, request: Request, account: CurrentAccount) -> Json:
    """读取固定引擎的真实选择目录，未配置模型不会合成示例项。"""
    methods = {
        "models": "catalog.listModels",
        "permissions": "catalog.listPermissions",
        "presets": "catalog.listAgentPresets",
    }
    if kind not in methods:
        raise DomainError(404, "unknown runtime catalog")
    return await service(request).call(account.user_id, methods[kind], {})


@router.post("/runtime/sessions", response_model=None)
async def create(body: SessionMessage, request: Request, account: RunnerAccount) -> Json:
    """同一稳定消息 ID 只提交一次真实 DSH 会话创建。"""
    return await service(request).call(
        account.user_id, "session.createAndStart", cast(Fields, body.model_dump(exclude_none=True))
    )


@router.post("/runtime/sessions/{session_id}/messages", response_model=None)
async def message(
    session_id: str, body: SessionMessage, request: Request, account: RunnerAccount
) -> Json:
    """继续当前用户会话；路由和正文身份必须一致。"""
    if session_id != body.sessionId:
        raise DomainError(422, "session identity mismatch")
    return await service(request).call(
        account.user_id, "session.startTurn", cast(Fields, body.model_dump(exclude_none=True))
    )


@router.post("/runtime/sessions/{session_id}/interrupt", response_model=None)
async def interrupt(session_id: str, request: Request, account: RunnerAccount) -> Json:
    """逐会话取消，不能用停止整个 Host 冒充会话取消。"""
    return await service(request).call(
        account.user_id, "session.interrupt", {"sessionId": session_id}
    )


@router.get("/runtime/sessions/{session_id}", response_model=None)
async def state(session_id: str, request: Request, account: CurrentAccount) -> Json:
    """读取原生会话状态用于核对未知结果和取消终态。"""
    return await service(request).call(
        account.user_id, "session.getState", {"sessionId": session_id}
    )


@router.get("/runtime/events", response_model=None)
async def events(
    request: Request, account: CurrentAccount, after: Annotated[int, Query(ge=0)] = 0
) -> Fields:
    """按持久游标返回有限页事件；传输接收不等于持久完成。"""
    values = await service(request).events(account.user_id, after)
    return {"events": cast(list[Json], values)}

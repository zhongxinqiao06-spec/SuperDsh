"""智能体定义、发布检查和资产入口，试用由工作台显式发送。"""

import base64
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.agents.entity.vo.agent_vo import AgentInput, AssetInput, InitializeInput
from app.modules.agents.service.agent_service import AgentService
from app.modules.identity.entity.bo.models import Account

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> AgentService:
    """使用应用装配的服务，避免控制器持有存储或 SQL。"""
    return request.app.state.services.agents


@router.get("/agents")
async def published(
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(100, ge=1, le=100),
    search: str = Query("", max_length=100),
) -> dict[str, object]:
    """普通工作台用户可以选择已发布智能体。"""
    return await service(request).list(account, page, pageSize, search)


@router.get("/admin/agents")
async def managed(
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(12, ge=1, le=100),
    search: str = Query("", max_length=100),
) -> dict[str, object]:
    """管理目录限定本人资源并支持搜索分页。"""
    return await service(request).list(account, page, pageSize, search, True)


@router.get("/admin/agents/catalog")
async def catalog(request: Request, account: AccountDep) -> dict[str, object]:
    """返回智能体组合需要的资产、知识库、技能与工具。"""
    return dict(await service(request).catalog(account))


@router.post("/admin/agents", status_code=201)
async def create(body: AgentInput, request: Request, account: AccountDep) -> dict[str, object]:
    """新定义通过业务校验后发布为可选择资源。"""
    return {"agent": await service(request).save(account, body)}


@router.put("/admin/agents/{agent_id}")
async def update(
    agent_id: str, body: AgentInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """客户端版本过期时返回冲突而非覆盖。"""
    return {"agent": await service(request).save(account, body, agent_id)}


@router.delete("/admin/agents/{agent_id}")
async def remove(agent_id: str, request: Request, account: AccountDep) -> dict[str, bool]:
    """删除立即阻止新执行，保留历史。"""
    await service(request).remove(account, agent_id)
    return {"ok": True}


@router.get("/admin/agents/{agent_id}/readiness")
async def readiness(agent_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    """执行检查不发起模型请求。"""
    return await service(request).readiness(account, agent_id)


@router.post("/admin/agents/initialize")
async def initialize(
    request: Request, account: AccountDep, body: Annotated[InitializeInput | None, Body()] = None
) -> dict[str, object]:
    """按配置导入默认组合，重复点击不覆盖用户编辑。"""
    return await service(request).initialize(account, bool(body and body.copyLatest))


@router.post("/admin/agents/assets", status_code=201)
async def asset_upload(
    body: AssetInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """兼容资料与模板上传并校验真实文件格式。"""
    return {"asset": await service(request).assets.upload(account, body)}


@router.get("/admin/agents/assets/{asset_id}/download")
async def asset_download(asset_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    """授权下载保持旧 Base64 响应，存储路径不出现在协议中。"""
    content, asset = await service(request).assets.content(account, asset_id)
    return {**asset, "contentBase64": base64.b64encode(content).decode()}


@router.get("/admin/agents/assets/{asset_id}/preview")
async def asset_preview(asset_id: str, request: Request, account: AccountDep) -> dict[str, object]:
    """预览由通用渲染服务提供，未配置外部渲染依赖时明确返回失败。"""
    return await service(request).assets.preview(
        account, asset_id, request.app.state.services.office_previews.preview_asset
    )

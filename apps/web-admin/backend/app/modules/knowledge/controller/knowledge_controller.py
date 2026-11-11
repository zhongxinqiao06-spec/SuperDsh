"""知识库与语义配置协议转换，不直接访问文件、SQL 或索引客户端。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.knowledge.entity.vo.knowledge_vo import (
    EmbeddingInput,
    IndexInput,
    KnowledgeInput,
    RestoreInput,
    SearchInput,
)
from app.modules.knowledge.service.knowledge_service import KnowledgeService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> KnowledgeService:
    """由统一应用装配注入知识用例。"""
    return request.app.state.services.knowledge


@router.get("/admin/knowledge-bases")
async def listing(
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(12, ge=1, le=100),
    search: str = Query("", max_length=100),
) -> dict[str, object]:
    """分页返回知识库配置。"""
    return await service(request).list(account, page, pageSize, search)


@router.get("/admin/knowledge-bases/search-status")
async def status(request: Request, account: AccountDep) -> dict[str, object]:
    """检索依赖状态与普通 HTTP 存活分开。"""
    return await service(request).status(account)


@router.post("/admin/knowledge-bases", status_code=201)
async def create(body: KnowledgeInput, request: Request, account: AccountDep) -> dict[str, object]:
    """新建配置返回旧 DTO 包装键。"""
    return {"knowledgeBase": await service(request).save(account, body)}


@router.put("/admin/knowledge-bases/{identifier}")
async def update(
    identifier: str, body: KnowledgeInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """按版本编辑资料集合。"""
    return {"knowledgeBase": await service(request).save(account, body, identifier)}


@router.delete("/admin/knowledge-bases/{identifier}")
async def remove(identifier: str, request: Request, account: AccountDep) -> dict[str, bool]:
    """删除后冻结会话也不能继续获取其资料。"""
    await service(request).remove(account, identifier)
    return {"ok": True}


@router.get("/admin/knowledge-bases/{identifier}/versions")
async def versions(
    identifier: str,
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=50),
) -> dict[str, object]:
    """返回可恢复的配置历史。"""
    return await service(request).versions(account, identifier, page, pageSize)


@router.post("/admin/knowledge-bases/{identifier}/restore")
async def restore(
    identifier: str, body: RestoreInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """回退追加新版本，响应保持 resource 包装。"""
    return {"resource": await service(request).restore(account, identifier, body)}


@router.get("/admin/knowledge-bases/{identifier}/index")
async def index_status(identifier: str, request: Request, account: AccountDep) -> dict[str, object]:
    """解析与索引失败在页面刷新后仍可见。"""
    return await service(request).document_status(account, identifier)


@router.post("/admin/knowledge-bases/{identifier}/index")
async def index(
    identifier: str, request: Request, account: AccountDep, body: IndexInput | None = None
) -> dict[str, object]:
    """索引单份或全部资料。"""
    return await service(request).index(account, identifier, body.assetId if body else None)


@router.post("/admin/knowledge-bases/{identifier}/search")
async def search(
    identifier: str, body: SearchInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """检索测试返回真实原文与定位字段。"""
    return await service(request).search(account, identifier, body.query)


@router.get("/admin/knowledge-embedding")
async def profile(request: Request, account: AccountDep) -> dict[str, object]:
    """模型配置只暴露凭据存在状态。"""
    return await service(request).profiles.view(account)


@router.put("/admin/knowledge-embedding")
async def save_profile(
    body: EmbeddingInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """新配置准备全部完成后切换，失败保留旧索引。"""
    return await service(request).profiles.save(account, body)


@router.post("/admin/knowledge-embedding/prepare-local")
async def prepare(request: Request, account: AccountDep) -> dict[str, object]:
    """显式准备固定本地模型。"""
    return await service(request).profiles.prepare_local(account)

"""扩展来源与工具配置HTTP协议，业务校验及副作用由服务承担。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.extensions.entity.vo.extensions import (
    InstallInput,
    McpConnectInput,
    McpDiscoveryInput,
    SourceCheckInput,
    SourceUpdateInput,
    ToolInput,
)
from app.modules.extensions.service.extension_service import ExtensionService
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.entity.vo.management import ResourceVersionInput

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ExtensionService:
    """应用装配提供来源服务，不在路由构造进程或数据库客户端。"""
    return request.app.state.services.extensions


@router.get("/admin/extensions")
async def sources(request: Request, account: AccountDep) -> dict[str, object]:
    """返回已安装来源与不含凭据的工具声明。"""
    return {"items": await service(request).list(account)}


@router.post("/admin/extensions/install", status_code=201)
async def install(body: InstallInput, request: Request, account: AccountDep) -> dict[str, object]:
    """安装并发布通过健康检查的包。"""
    return await service(request).install(account, body)


@router.post("/admin/extensions/mcp/discover")
async def discover(
    body: McpDiscoveryInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """发现工具而不授予调用权限。"""
    return await service(request).discover(account, body)


@router.post("/admin/extensions/mcp", status_code=201)
async def connect(
    body: McpConnectInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """按确认的发现摘要发布所选工具。"""
    return await service(request).connect(account, body)


@router.put("/admin/extensions/{identifier}")
async def update(
    identifier: str, body: SourceUpdateInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """变更来源可用性或活动版本。"""
    return await service(request).update(account, identifier, body)


@router.post("/admin/extensions/{identifier}/check")
async def check(
    identifier: str, body: SourceCheckInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """运行健康检查并保留脱敏诊断。"""
    return await service(request).check(account, identifier, body.version)


@router.get("/admin/tools")
async def tools(
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=100),
    search: str = Query("", max_length=100),
) -> dict[str, object]:
    """工具配置按本人资源分页，来源目录不混入配置列表。"""
    return await request.app.state.services.resources.list(account, "tool", page, pageSize, search)


@router.post("/admin/tools", status_code=201)
async def create_tool(body: ToolInput, request: Request, account: AccountDep) -> dict[str, object]:
    """创建绑定固定实现和加密配置的工具。"""
    return {
        "tool": await request.app.state.services.resources.save(
            account, "tool", body.model_dump(exclude_unset=True)
        )
    }


@router.put("/admin/tools/{identifier}")
async def save_tool(
    identifier: str, body: ToolInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """只更新指定版本，冲突由资源服务统一处理。"""
    if body.version is None:
        raise DomainError(422, "编辑工具必须携带当前版本")
    return {
        "tool": await request.app.state.services.resources.save(
            account, "tool", body.model_dump(exclude_unset=True), identifier
        )
    }


@router.delete("/admin/tools/{identifier}", status_code=204)
async def delete_tool(identifier: str, request: Request, account: AccountDep) -> None:
    """仍被技能或智能体使用的工具不能删除。"""
    await request.app.state.services.resources.delete(account, "tool", identifier)


@router.get("/admin/tools/{identifier}/versions")
async def versions(
    identifier: str,
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=100),
) -> dict[str, object]:
    """历史快照不包含密文或原始凭据。"""
    result = await request.app.state.services.resources.versions(account, "tool", identifier)
    return {
        **result,
        "items": result["items"][(page - 1) * pageSize : page * pageSize],
        "page": page,
        "pageSize": pageSize,
    }


@router.post("/admin/tools/{identifier}/restore")
async def restore(
    identifier: str, body: ResourceVersionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """还原历史配置追加新版本并保留历史密文。"""
    if body.sourceVersion is None:
        raise DomainError(422, "请选择来源版本")
    return {
        "resource": await request.app.state.services.resources.restore(
            account, "tool", identifier, body.sourceVersion, body.version
        )
    }

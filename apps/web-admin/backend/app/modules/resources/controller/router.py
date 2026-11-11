"""配置资源基础 CRUD，具体工具执行不由这些管理路由驱动。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.vo.dto import ResourceInput
from app.modules.resources.service.resources import ResourceService

router = APIRouter()
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> ResourceService:
    return request.app.state.services.resources


def resource_router(kind: str, path: str) -> APIRouter:
    """同一资源合同按稳定能力注册，不按助手名称产生业务分支。"""
    child = APIRouter(prefix=path)

    @child.get("")
    async def list_resources(
        request: Request,
        account: AccountDep,
        page: int = Query(1, ge=1),
        pageSize: int = Query(25, ge=1, le=200),
        search: str = Query("", max_length=200),
    ) -> dict[str, object]:
        return await service(request).list(account, kind, page, pageSize, search)

    @child.post("")
    async def create_resource(
        body: ResourceInput, request: Request, account: AccountDep
    ) -> dict[str, object]:
        return await service(request).save(
            account, kind, body.model_dump(exclude_none=True, exclude_unset=True)
        )

    @child.put("/{resource_id}")
    async def save_resource(
        resource_id: str, body: ResourceInput, request: Request, account: AccountDep
    ) -> dict[str, object]:
        return await service(request).save(
            account, kind, body.model_dump(exclude_none=True, exclude_unset=True), resource_id
        )

    @child.delete("/{resource_id}", status_code=204)
    async def delete_resource(resource_id: str, request: Request, account: AccountDep) -> None:
        await service(request).delete(account, kind, resource_id)

    @child.get("/{resource_id}/versions")
    async def versions(
        resource_id: str, request: Request, account: AccountDep
    ) -> dict[str, object]:
        return await service(request).versions(account, kind, resource_id)

    return child


for resource_kind, resource_path in (
    ("agent", "/resources/agents"),
    ("skill", "/resources/skills"),
    ("tool", "/resources/tools"),
    ("knowledge", "/resources/knowledge-bases"),
    ("extension", "/resources/extensions"),
):
    router.include_router(resource_router(resource_kind, resource_path))


@router.post("/resources/extensions/install")
async def declare_extension(
    body: ResourceInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """第一阶段登记安装声明与 Schema；可执行包安装由后续扩展生命周期实现。"""
    return await service(request).save(
        account, "extension", body.model_dump(exclude_none=True, exclude_unset=True)
    )

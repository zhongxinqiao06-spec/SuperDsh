"""技能管理HTTP协议，程序运行仍由会话与固定DSH入口触发。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.skills.entity.vo.management import (
    ExtensionSkillInput,
    ResourceVersionInput,
    SkillImportInput,
    SkillInput,
    SkillMatchInput,
)
from app.modules.skills.service.management_service import SkillManagementService

router = APIRouter(prefix="/admin/skills")
AccountDep = Annotated[Account, Depends(current_account)]


def service(request: Request) -> SkillManagementService:
    """依赖来自应用生命周期，路由不拥有资源状态。"""
    return request.app.state.services.skill_management


@router.get("")
async def skills(
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=100),
    search: str = Query("", max_length=100),
) -> dict[str, object]:
    """按名称或说明筛选本人技能。"""
    return await service(request).resources.list(account, "skill", page, pageSize, search)


@router.post("", status_code=201)
async def create(body: SkillInput, request: Request, account: AccountDep) -> dict[str, object]:
    """保存文本技能或带阶段草稿的技能。"""
    return {"skill": await service(request).save(account, body)}


@router.post("/match-preview")
async def match(body: SkillMatchInput, request: Request, account: AccountDep) -> dict[str, object]:
    """返回匹配评分及排除原因。"""
    return {"candidates": await service(request).match(account, body)}


@router.post("/import", status_code=201)
async def import_package(
    body: SkillImportInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """数据包导入失败会补偿本次新增资产。"""
    return {"skill": await service(request).import_package(account, body)}


@router.post("/import-extension", status_code=201)
async def import_extension(
    body: ExtensionSkillInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """导入已授权扩展声明的技能资料。"""
    return {"skill": await service(request).import_extension(account, body)}


@router.put("/{identifier}")
async def save(
    identifier: str, body: SkillInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """编辑保留未提交的资料引用；并发修改返回409。"""
    if body.version is None:
        raise DomainError(422, "编辑技能必须携带当前版本")
    return {"skill": await service(request).save(account, body, identifier)}


@router.delete("/{identifier}", status_code=204)
async def delete(identifier: str, request: Request, account: AccountDep) -> None:
    """检查依赖后软删除，冻结历史保留。"""
    await service(request).resources.delete(account, "skill", identifier)


@router.post("/{identifier}/publish")
async def publish(
    identifier: str, body: ResourceVersionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """将已校验草稿发布成新版本。"""
    return {"skill": await service(request).publish(account, identifier, body.version)}


@router.get("/{identifier}/versions")
async def versions(
    identifier: str,
    request: Request,
    account: AccountDep,
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=100),
) -> dict[str, object]:
    """分页读取历史版本。"""
    result = await service(request).resources.versions(account, "skill", identifier)
    items = result["items"]
    assert isinstance(items, list)
    return {
        **result,
        "items": items[(page - 1) * pageSize : page * pageSize],
        "page": page,
        "pageSize": pageSize,
    }


@router.post("/{identifier}/restore")
async def restore(
    identifier: str, body: ResourceVersionInput, request: Request, account: AccountDep
) -> dict[str, object]:
    """回退前重新验证阶段和引用，不恢复不可用工具。"""
    if body.sourceVersion is None:
        raise DomainError(422, "请选择来源版本")
    return {
        "resource": await service(request).resources.restore(
            account, "skill", identifier, body.sourceVersion, body.version
        )
    }

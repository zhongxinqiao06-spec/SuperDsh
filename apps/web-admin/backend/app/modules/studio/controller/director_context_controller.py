"""导演参考资料入口，调用公开用例，不在路由中查询或拼接供应商请求。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.api.dependencies import require_permission
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.entity.vo.director_context_vo import PrepareDirectorContext

router = APIRouter(prefix="/studio", tags=["导演参考资料"])
User = Annotated[Account, Depends(require_permission("products.entertainment"))]


@router.get("/projects/{project}/director-context")
async def inspect(project: str, request: Request, account: User) -> dict:
    return await request.app.state.services.director_context.inspect(account, project)


@router.post("/projects/{project}/director-context")
async def prepare(
    project: str, body: PrepareDirectorContext, request: Request, account: User
) -> dict:
    return await request.app.state.services.director_context.prepare(account, project, body)

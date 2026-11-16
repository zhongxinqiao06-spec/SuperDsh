"""办公首页只读成果入口，未授权的账号不能枚举会话与文件。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.api.dependencies import current_account
from app.modules.identity.entity.bo.models import Account

router = APIRouter(prefix="/office", tags=["office"])


@router.get("/recent-deliverables")
async def recent_deliverables(
    request: Request,
    account: Annotated[Account, Depends(current_account)],
    limit: Annotated[int, Query(ge=1, le=10)] = 4,
) -> dict[str, object]:
    """按真实入库时间返回有限成果，客户端持稳定会话与成果 ID 打开。"""
    return await request.app.state.services.evidence.recent_office_deliverables(account, limit)

"""全站公共商品卡面及受账务权限保护的卡种管理。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response

from app.api.dependencies import current_account
from app.modules.billing.entity.vo.cards import CardType, CardTypeInput, CardTypes
from app.modules.billing.service.card_catalog import CardCatalog
from app.modules.identity.entity.bo.models import Account

router = APIRouter()
Actor = Annotated[Account, Depends(current_account)]
Key = Annotated[str, Path(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


def catalog(request: Request) -> CardCatalog:
    return CardCatalog(request.app.state.database)


@router.get("/admin/billing/card-types")
async def list_types(request: Request, account: Actor) -> CardTypes:
    return await catalog(request).list(account)


@router.post("/admin/billing/card-types/{key}", status_code=201)
async def create_type(key: Key, body: CardTypeInput, request: Request, account: Actor) -> CardType:
    return await catalog(request).save(account, key, body, True)


@router.put("/admin/billing/card-types/{key}")
async def edit_type(key: Key, body: CardTypeInput, request: Request, account: Actor) -> CardType:
    return await catalog(request).save(account, key, body, False)


@router.get("/billing/card-images/{digest}")
async def cover(
    digest: Annotated[str, Path(pattern=r"^[a-f0-9]{64}$")], request: Request
) -> Response:
    return Response(
        await catalog(request).image(digest),
        media_type="image/webp",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )

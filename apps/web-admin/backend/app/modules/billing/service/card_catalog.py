"""图片只接受经过解码和重新编码的静态像素，历史卡通过内容摘要读取原图。"""

import asyncio
import base64
import binascii
import hashlib
import io
import re

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.dialects.postgresql import insert

from app.infrastructure.database import Database, lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.billing.dao.card_dao import types
from app.modules.billing.entity.do.card_do import CardImageRow, CardTypeRow
from app.modules.billing.entity.vo.cards import CardType, CardTypeInput, CardTypes
from app.modules.identity.entity.bo.models import Account

BUILTIN_IMAGES = {
    f"/images/credit-cards/{key}.webp"
    for key in ("film", "slate", "lens", "spotlight", "projector")
}
PREFIX = "/api/billing/card-images/"


def normalize_image(value: str) -> bytes:
    try:
        header, data = value.split(",", 1)
        if header not in {
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/webp;base64",
        }:
            raise ValueError()
        raw = base64.b64decode(data, validate=True)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError()
        with Image.open(io.BytesIO(raw)) as img:
            if (
                getattr(img, "is_animated", False)
                or img.format not in {"PNG", "JPEG", "WEBP"}
                or img.width * img.height > 12000000
                or img.width < 1
                or img.height < 1
            ):
                raise ValueError()
            cover = ImageOps.exif_transpose(img).convert("RGB")
            cover.thumbnail((1600, 1000))
            buffer = io.BytesIO()
            cover.save(buffer, "WEBP", quality=88)
            return buffer.getvalue()
    except (
        ValueError,
        OSError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        binascii.Error,
    ) as exc:
        raise DomainError(422, "请上传 2 MB 以内的 JPG、PNG 或 WebP 静态图片") from exc


class CardCatalog:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def list(self, actor: Account) -> CardTypes:
        actor.require("billing.read")
        async with self.database.sessions() as db:
            return CardTypes(items=await types(db, False))

    async def save(self, actor: Account, key: str, body: CardTypeInput, create: bool) -> CardType:
        actor.require("billing.read")
        actor.require("billing.plans.manage")
        picture = body.image
        content = None
        if picture.startswith("data:"):
            content = await asyncio.to_thread(normalize_image, picture)
            picture = PREFIX + hashlib.sha256(content).hexdigest()
        async with self.database.sessions.begin() as db:
            await lock_transaction(db, "billing:card-type:" + key)
            row = await db.get(CardTypeRow, key, with_for_update=True)
            fields = body.model_dump(exclude={"revision", "image"})
            fields["image"] = picture
            if (
                row
                and row.revision == body.revision + 1
                and all(getattr(row, k) == v for k, v in fields.items())
            ):
                return CardType.model_validate(row)
            if (create and (row or body.revision != 0)) or (
                not create and (not row or row.revision != body.revision)
            ):
                raise DomainError(409, "卡种已变更，请刷新后重新编辑")
            if content:
                await db.execute(
                    insert(CardImageRow)
                    .values(digest=picture[len(PREFIX) :], content=content)
                    .on_conflict_do_nothing()
                )
            elif picture not in BUILTIN_IMAGES and not (
                picture.startswith(PREFIX)
                and re.fullmatch(r"[a-f0-9]{64}", picture[len(PREFIX) :])
                and (await db.get(CardImageRow, picture[len(PREFIX) :])) is not None
            ):
                raise DomainError(422, "卡面图片不存在")
            if row is None:
                row = CardTypeRow(id=key)
                db.add(row)
            for k, v in fields.items():
                setattr(row, k, v)
            row.revision = body.revision + 1
            return CardType.model_validate(row)

    async def image(self, digest: str) -> bytes:
        async with self.database.sessions() as db:
            image = await db.get(CardImageRow, digest)
            if image is None:
                raise DomainError(404, "卡面图片不存在")
            return image.content

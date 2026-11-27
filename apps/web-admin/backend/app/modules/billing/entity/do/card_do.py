"""可维护的卡种以及不可变的卡面图片。"""

from sqlalchemy import LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class CardTypeRow(Base):
    __tablename__ = "billing_card_types"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    points: Mapped[int]
    valid_days: Mapped[int]
    image: Mapped[str] = mapped_column(String(180))
    enabled: Mapped[bool]
    revision: Mapped[int]


class CardImageRow(Base):
    __tablename__ = "billing_card_images"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    content: Mapped[bytes] = mapped_column(LargeBinary)

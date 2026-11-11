"""导航持久化实体，不含业务方法。"""

from sqlalchemy import Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class NavigationRow(Base):
    """单平台全局菜单，更新通过版本条件串行化。"""

    __tablename__ = "navigation_settings"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    items: Mapped[list[dict[str, object]]] = mapped_column(JSONB)
    updated_by: Mapped[str | None] = mapped_column(String(80))

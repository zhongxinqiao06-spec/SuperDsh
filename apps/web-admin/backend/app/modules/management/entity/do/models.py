"""平台设置与每日统计快照的持久映射，不含业务或网络调用。"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class SettingRow(Base):
    """设置正文与密文分开；只读 API 不返回 secret。"""

    __tablename__ = "platform_settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict[str, object]] = mapped_column(JSONB)
    secret: Mapped[str | None] = mapped_column(Text)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DashboardSnapshotRow(Base):
    """按日期和时区保存可重复计算的统计结果。"""

    __tablename__ = "management_dashboard_snapshots"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    value: Mapped[dict[str, object]] = mapped_column(JSONB)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

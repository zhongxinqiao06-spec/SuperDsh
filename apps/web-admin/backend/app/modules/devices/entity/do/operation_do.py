"""设备 Shell 收据和终端根绑定，进程重启不导致命令重新执行。"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class ShellTaskRow(Base):
    """先记录运行意图；中断收据只可查询，不自动重放有副作用的命令。"""

    __tablename__ = "web_shell_tasks"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    connector_id: Mapped[str] = mapped_column(String(100), index=True)
    session_id: Mapped[str] = mapped_column(String(150))
    command: Mapped[str] = mapped_column(Text)
    request_hash: Mapped[str] = mapped_column(String(64))
    root: Mapped[str] = mapped_column(Text)
    cwd: Mapped[str] = mapped_column(Text)
    timeout_ms: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(30))
    result: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TerminalBindingRow(Base):
    """终端操作必须同时匹配账号、设备和会话，不能靠可猜的终端 ID 越权。"""

    __tablename__ = "web_terminal_bindings"
    terminal_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), index=True)
    connector_id: Mapped[str] = mapped_column(String(100), index=True)
    session_id: Mapped[str] = mapped_column(String(150))
    root: Mapped[str] = mapped_column(Text)
    cwd: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

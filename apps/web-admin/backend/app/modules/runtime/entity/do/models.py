"""DSH 投影批次、checkpoint 和幂等收据；不存供应商或登录凭据。"""

from sqlalchemy import JSON, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base
from app.modules.runtime.entity.bo.values import Fields, Json


class RuntimeBatch(Base):
    """已提交投影批次，序列唯一约束防止重放造成重复持久化。"""

    __tablename__ = "runtime_batches"
    __table_args__ = (UniqueConstraint("owner", "stream", "sequence"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    owner: Mapped[str] = mapped_column(String(128), index=True)
    stream: Mapped[str] = mapped_column(String(128))
    sequence: Mapped[int] = mapped_column(Integer)
    payload: Mapped[Fields] = mapped_column(JSON)
    acknowledgement: Mapped[Fields] = mapped_column(JSON)


class RuntimeCheckpoint(Base):
    """投影 checkpoint 和事件批次共用短事务提交。"""

    __tablename__ = "runtime_checkpoints"
    owner: Mapped[str] = mapped_column(String(128), primary_key=True)
    external_session: Mapped[str] = mapped_column(String(256), primary_key=True)
    payload: Mapped[Fields] = mapped_column(JSON)


class RuntimeReceipt(Base):
    """命令发送前预留稳定键，未知结果不会因重启自动再发。"""

    __tablename__ = "runtime_receipts"
    owner: Mapped[str] = mapped_column(String(128), primary_key=True)
    identifier: Mapped[str] = mapped_column(String(256), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(32), default="outcome_unknown")
    result: Mapped[Json] = mapped_column(JSON, nullable=True)


class RuntimeExecutionFence(Base):
    """跨租约失效保留执行者事实；只有确认旧进程退出后才删除。"""

    __tablename__ = "runtime_execution_fences"
    owner: Mapped[str] = mapped_column(String(128), primary_key=True)
    generation: Mapped[str] = mapped_column(String(64))
    machine: Mapped[str] = mapped_column(String(256))
    pid: Mapped[int | None] = mapped_column(Integer, nullable=True)

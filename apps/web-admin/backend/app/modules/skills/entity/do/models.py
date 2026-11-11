"""通用阶段运行、确认、收据及成果证据的数据实体。"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class SkillRunRow(Base):
    """阶段程序快照与稳定请求键，重启不自动再次执行工具。"""

    __tablename__ = "skill_runs"
    __table_args__ = (UniqueConstraint("owner_id", "session_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(200))
    binding_id: Mapped[str] = mapped_column(ForeignKey("resource_bindings.id"))
    request_id: Mapped[str] = mapped_column(String(200))
    program: Mapped[dict[str, object]] = mapped_column(JSONB)
    state: Mapped[str] = mapped_column(String(40))
    stage_index: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer)
    plan_hash: Mapped[str | None] = mapped_column(String(64))
    approved_hash: Mapped[str | None] = mapped_column(String(64))
    pending_call: Mapped[str | None] = mapped_column(String(200))
    outputs: Mapped[dict[str, object]] = mapped_column(JSONB)


class RunEventRow(Base):
    """每个已提交状态版本对应一条可追踪事件。"""

    __tablename__ = "skill_events"
    run_id: Mapped[str] = mapped_column(ForeignKey("skill_runs.id"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(60))
    payload: Mapped[dict[str, object]] = mapped_column(JSONB)


class ApprovalRow(Base):
    """确认引用具体 run/revision/输入哈希，不复用旧修订确认。"""

    __tablename__ = "approvals"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("skill_runs.id"))
    revision: Mapped[int] = mapped_column(Integer)
    plan_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(30))


class OperationReceiptRow(Base):
    """副作用提交前先记账，未知结果绝不转换为可自动重试。"""

    __tablename__ = "operation_receipts"
    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    run_id: Mapped[str] = mapped_column(ForeignKey("skill_runs.id"))
    revision: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(40))
    result: Mapped[dict[str, object] | None] = mapped_column(JSONB)


class ArtifactRow(Base):
    """成果只引用受管对象，不接受客户端任意文件路径。"""

    __tablename__ = "artifacts"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    session_id: Mapped[str] = mapped_column(String(200))
    run_id: Mapped[str | None] = mapped_column(ForeignKey("skill_runs.id"))
    media_type: Mapped[str] = mapped_column(String(200))
    object_key: Mapped[str] = mapped_column(String(500))
    sha256: Mapped[str] = mapped_column(String(64))
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSONB)


class EvidenceRow(Base):
    """证据指向真实授权来源，不能只保存模型声称通过。"""

    __tablename__ = "evidence"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    run_id: Mapped[str] = mapped_column(ForeignKey("skill_runs.id"))
    kind: Mapped[str] = mapped_column(String(60))
    source_id: Mapped[str] = mapped_column(String(200))
    source_hash: Mapped[str] = mapped_column(String(64))
    detail: Mapped[dict[str, object]] = mapped_column(JSONB)


class ToolExecutionRow(Base):
    """普通工具和阶段工具共用真实调用收据，不伪造技能运行。"""

    __tablename__ = "web_tool_executions"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(100), index=True)
    binding_id: Mapped[str] = mapped_column(ForeignKey("resource_bindings.id"))
    tool_id: Mapped[str] = mapped_column(String(100))
    call_id: Mapped[str] = mapped_column(String(200))
    phase: Mapped[str] = mapped_column(String(30))
    input_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(30))
    arguments: Mapped[dict[str, object]] = mapped_column(JSONB)
    result: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    plan_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    skill_run_id: Mapped[str | None] = mapped_column(ForeignKey("skill_runs.id"), nullable=True)
    skill_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

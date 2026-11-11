"""阶段运行的持久值对象；模型自述不能代替执行收据与证据。"""

from dataclasses import dataclass, field


@dataclass
class SkillRun:
    """version 保护并发提交，revision 使旧确认和迟到结果失效。"""

    id: str
    owner_id: str
    session_id: str
    binding_id: str
    request_id: str
    program: dict[str, object]
    state: str = "running"
    stage_index: int = 0
    revision: int = 1
    version: int = 1
    plan_hash: str | None = None
    approved_hash: str | None = None
    pending_call: str | None = None
    outputs: dict[str, object] = field(default_factory=dict)

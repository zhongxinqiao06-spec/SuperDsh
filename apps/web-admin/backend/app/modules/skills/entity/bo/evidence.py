"""成果和证据的公开业务值对象，文件字节不进入运行状态。"""

from dataclasses import dataclass, field


@dataclass
class Artifact:
    """成果引用归属会话的受管对象及其真实摘要。"""

    id: str
    owner_id: str
    session_id: str
    run_id: str | None
    media_type: str
    object_key: str
    sha256: str
    metadata_json: dict[str, object] = field(default_factory=dict)


@dataclass
class Evidence:
    """证据只能来源于已核实执行收据或文件，不接受模型自述通过。"""

    id: str
    owner_id: str
    run_id: str
    kind: str
    source_id: str
    source_hash: str
    detail: dict[str, object]

"""可组合资源与会话绑定的值对象，工具实现和配置版本分开记录。"""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Resource:
    """配置资源的当前版本；历史快照不能被后续编辑覆盖。"""

    id: str
    kind: str
    owner_id: str
    name: str
    description: str
    enabled: bool
    published: bool
    version: int
    payload: dict[str, object]
    secret_ciphertext: str | None = None
    deleted: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Binding:
    """冻结的资源/实现版本及 owner，会话无权调用未绑定工具。"""

    id: str
    owner_id: str
    session_id: str
    version: int
    snapshots: list[dict[str, object]] = field(default_factory=list)

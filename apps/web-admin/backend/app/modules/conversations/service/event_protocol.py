"""会话事件保持现有客户端的信封、稳定摘要和游标契约。"""

import hashlib
import json
from datetime import UTC, datetime

from app.integrations.dsh.protocol import contract


def event_envelope(
    session_id: str,
    sequence: int,
    kind: str,
    payload: dict[str, object],
    emitted_at: datetime | None = None,
) -> dict[str, object]:
    """摘要绑定类型与内容，重发相同投影仍有相同标识，时间不参与去重。"""
    serialized = json.dumps([kind, payload], ensure_ascii=False, separators=(",", ":"))
    fingerprint = hashlib.sha256(serialized.encode()).hexdigest()[:12]
    return {
        "protocolVersion": contract()["protocolVersion"],
        "eventId": f"evt_{sequence}_{fingerprint}",
        "sequence": sequence,
        "cursor": f"seq:{sequence}",
        "type": kind,
        "sessionId": session_id,
        "emittedAt": (emitted_at or datetime.now(UTC)).isoformat(),
        "payload": payload,
    }

"""会话列表的公开键集游标；协议格式独立于产品发布版本。"""

import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from pathlib import Path

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.vo.timeline_query import MAX_SAFE_INTEGER


@cache
def cursor_version() -> int:
    """从随应用发布的契约资产读取格式号，禁止按应用版本猜测游标。"""
    path = Path(__file__).resolve().parents[6] / "contracts" / "session-cursor.json"
    value = json.loads(path.read_text(encoding="utf-8")).get("schemaVersion")
    if type(value) is not int or value < 1:
        raise RuntimeError("invalid session cursor contract")
    return value


def cursor_time(value: datetime) -> str:
    """游标时间采用既有UTC毫秒表示，与数据库键集文本表达式保持一致。"""
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class SessionCursor:
    """保存排序时的完整边界，不要求锚点会话仍存在或保持原排序。"""

    pinned: int
    sort_at: str
    item_order: int
    sequence: int
    identifier: str

    def encode(self) -> str:
        value = {
            "v": cursor_version(),
            "p": self.pinned,
            "s": self.sort_at,
            "o": self.item_order,
            "u": self.sequence,
            "i": self.identifier,
        }
        return (
            base64.urlsafe_b64encode(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
            )
            .decode()
            .rstrip("=")
        )

    @classmethod
    def decode(cls, raw: str) -> "SessionCursor":
        """保留旧游标类型约束及400错误，不把不存在的锚点当作失效游标。"""
        try:
            value = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
            if (
                not isinstance(value, dict)
                or not isinstance(value.get("v"), (int, float))
                or isinstance(value.get("v"), bool)
                or value["v"] != cursor_version()
            ):
                raise ValueError("invalid cursor version")
            pinned = value.get("p")
            pinned = 0 if pinned is None or pinned == "" else float(pinned)
            if (
                pinned not in (0, 1)
                or not isinstance(value.get("s"), str)
                or not isinstance(value.get("i"), str)
                or not value["i"]
            ):
                raise ValueError("invalid cursor key")
            for key in ("o", "u"):
                number = value.get(key)
                if (
                    not isinstance(number, (int, float))
                    or isinstance(number, bool)
                    or not float(number).is_integer()
                    or abs(number) > MAX_SAFE_INTEGER
                ):
                    raise ValueError("invalid cursor sequence")
            return cls(int(pinned), value["s"], int(value["o"]), int(value["u"]), value["i"])
        except (ValueError, TypeError, OverflowError, UnicodeError) as error:
            raise DomainError(400, "invalid session cursor") from error

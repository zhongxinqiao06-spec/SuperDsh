"""时间线查询保留客户端的安全整数与恢复游标语义。"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from app.infrastructure.errors import DomainError
from app.infrastructure.query_parameters import MAX_SAFE_INTEGER, query_integer


def event_cursor(query: Mapping[str, str]) -> int:
    """after 优先于 cursor；游标只接受无前导零的 ASCII 十进制安全整数。"""
    value = query.get("after") or query.get("cursor") or "seq:0"
    if len(value) > 20 or not re.fullmatch(r"seq:(0|[1-9][0-9]*)", value):
        raise DomainError(422, "invalid event cursor")
    sequence = int(value[4:])
    if sequence > MAX_SAFE_INTEGER:
        raise DomainError(422, "invalid event cursor")
    return sequence


@dataclass(frozen=True)
class TimelineQuery:
    """历史页按 orderSeq 翻页，变化页按 updatedSeq 恢复，两种游标不可混用。"""

    mode: str = "latest"
    after: int = 0
    before: int | None = None
    limit: int = 100

    @classmethod
    def parse(cls, query: Mapping[str, str]) -> "TimelineQuery":
        """先解析数值再检查模式，保持既有错误优先级。"""
        mode = query.get("mode") or "latest"
        after = query_integer(query.get("afterSeq"), 0)
        before = (
            query_integer(query.get("beforeOrderSeq"), 1, 1) if "beforeOrderSeq" in query else None
        )
        limit = query_integer(query.get("limit"), 100, 1, 500)
        if mode not in {"latest", "history", "changes"}:
            raise DomainError(422, "invalid timeline mode")
        if mode == "history" and before is None:
            raise DomainError(422, "beforeOrderSeq is required")
        return cls(mode, after, before, limit)

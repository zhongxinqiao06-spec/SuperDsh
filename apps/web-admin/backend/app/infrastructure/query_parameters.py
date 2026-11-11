"""HTTP查询参数的兼容数值解析，不依赖具体业务领域。"""

import math
import re

from app.infrastructure.errors import DomainError

MAX_SAFE_INTEGER = 2**53 - 1


def query_integer(
    value: str | None, fallback: int, minimum: int = 0, maximum: int = MAX_SAFE_INTEGER
) -> int:
    """兼容 URL 数字输入，拒绝溢出、分数及非有限数，避免截断恢复位置。"""
    if value is None or value == "":
        return fallback
    try:
        text = value.strip()
        if text and not re.fullmatch(
            r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+",
            text,
        ):
            raise ValueError("invalid numeric syntax")
        number = (
            float(int(text, 0))
            if re.fullmatch(r"0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+", text)
            else float(text or "0")
        )
        if not math.isfinite(number) or not number.is_integer() or not minimum <= number <= maximum:
            raise ValueError("integer outside range")
        return int(number)
    except (ValueError, OverflowError) as error:
        raise DomainError(422, "invalid integer parameter") from error

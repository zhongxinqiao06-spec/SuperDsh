"""仪表盘设置的局部更新与统计区间规则，不承担持久化或请求处理。"""

import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.infrastructure.errors import DomainError
from app.infrastructure.query_parameters import query_integer


def record(value: object) -> dict[str, object]:
    """只接纳 JSON 对象；显式 null 不是省略整个配置分区。"""
    if not isinstance(value, dict):
        raise DomainError(422, "expected an object")
    return value


def integer(value: object, fallback: int) -> int:
    """保留旧 JSON 数值转换及安全整数边界，避免浮点截断阈值。"""
    if value is None or value == "":
        return fallback
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        return query_integer(str(value), fallback)
    if isinstance(value, list):
        # JavaScript Number([]) 为零；单元素数组先按字符串转换，其余组合无效。
        if not value or value == [None]:
            return 0
        if len(value) == 1 and not isinstance(value[0], (dict, bool)):
            return integer(value[0], 0)
    raise DomainError(422, "invalid integer parameter")


def normalized_bins(value: object) -> list[int]:
    """边界归零、去重、排序；省略单个直方图数组仍按原契约报错。"""
    if not isinstance(value, list) or len(value) > 100:
        raise DomainError(422, "invalid histogram bins")
    return sorted({0, *(integer(item, 0) for item in value)})


def merge_settings(current: dict[str, object], patch: dict[str, object]) -> dict[str, object]:
    """省略分区保留原值，传入分区按旧规则完整解析，阈值次序自动收敛。"""
    intensity = record(patch.get("intensity", current["intensity"]))
    bins = record(patch.get("histogramBins", current["histogramBins"]))
    light = integer(intensity.get("lightMax"), 10)
    medium = max(light, integer(intensity.get("mediumMax"), 50))
    return {
        "intensity": {"basis": "messages", "lightMax": light, "mediumMax": medium},
        "histogramBins": {
            "messages": normalized_bins(bins.get("messages")),
            "sessions": normalized_bins(bins.get("sessions")),
        },
    }


def dashboard_date(value: str) -> date:
    """只接受完整自然日，拒绝 Python 额外接受的紧凑或周日期格式。"""
    try:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            raise ValueError("invalid date syntax")
        return date.fromisoformat(value)
    except ValueError as error:
        raise DomainError(422, "invalid dashboard date") from error


def overview_range(start: str, end: str, zone: str) -> tuple[str, str, str]:
    """默认日期基于所选结束日，空时区与省略时区使用同一个公开默认值。"""
    zone = zone or "Asia/Shanghai"
    if not end:
        try:
            end = datetime.now(ZoneInfo(zone)).date().isoformat()
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise DomainError(422, "invalid timezone") from error
    if not start:
        start = (dashboard_date(end) - timedelta(days=29)).isoformat()
    return start, end, zone

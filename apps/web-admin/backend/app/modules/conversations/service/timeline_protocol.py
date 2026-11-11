"""时间线时间边界归一化，平台接收时间与消息创建时间保持独立。"""

from datetime import UTC, datetime


def item_timestamp(value: object, received_at: datetime) -> datetime:
    """优先保留合法 createdAt；缺失或非法的历史输入使用本次已记录接收时间。"""
    if isinstance(value, str) and value:
        try:
            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return (
                timestamp.replace(tzinfo=UTC)
                if timestamp.tzinfo is None
                else timestamp.astimezone(UTC)
            )
        except ValueError:
            pass
    return received_at

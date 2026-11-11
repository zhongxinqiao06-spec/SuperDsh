"""公开文本边界的稳定校验，不承担网络、授权或持久化。"""

from app.infrastructure.errors import DomainError


def required_text(value: object, name: str, maximum: int = 4096) -> str:
    """保留旧客户端可识别的字段错误，同时拒绝非字符串和空白值。"""
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise DomainError(422, f"{name} is required or invalid")
    return value

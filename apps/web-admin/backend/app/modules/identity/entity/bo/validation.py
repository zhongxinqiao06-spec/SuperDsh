"""身份公开值的统一规范化规则，不依赖 HTTP 或数据库。"""

import hashlib
import re

from app.infrastructure.errors import DomainError


def account_username(value: str, email: str | None) -> str:
    """未显式命名时按旧规则从邮箱推导；持久化冲突仍由事务内用例处理。"""
    username = value.strip().lower()
    if not username and email:
        username = re.sub(r"[^a-z0-9_-]", "-", email.split("@")[0])[:32]
        if len(username) < 3:
            username = "user-" + username
    if not re.fullmatch(r"[a-z0-9_-]{3,32}", username):
        raise DomainError(
            422, "username must be 3-32 lowercase letters, digits, hyphen or underscore"
        )
    return username


def collision_username(username: str, email: str) -> str:
    """自动用户名重复时使用确定性邮箱摘要，不能替调用方更改显式用户名。"""
    return username[:23] + "-" + hashlib.sha256(email.encode()).hexdigest()[:8]


def display_name(value: object) -> str:
    """显示名称沿用旧端去空白、1至64个UTF-16单元及控制字符限制。"""
    name = value.strip() if isinstance(value, str) else ""
    if (
        not name
        or len(name.encode("utf-16-le", errors="surrogatepass")) // 2 > 64
        or re.search(r"[\x00-\x1f]", name)
    ):
        raise DomainError(422, "display name must be 1-64 characters")
    return name


def login_identifier(value: str) -> str:
    """登录名不按邮箱限长；邮箱登录必须采用与注册相同的规范化校验。"""
    normalized = value.strip().lower()
    if not normalized:
        raise DomainError(422, "login identifier is required")
    return email_address(normalized) if "@" in normalized else normalized


def email_address(value: str) -> str:
    """兼容旧邮箱本地部分和国际化域名规则，拒绝控制字符及非法域标签。"""
    raw = value.strip().lower()
    parts = raw.split("@")
    local = parts[0]
    try:
        domain = parts[1].encode("idna").decode("ascii") if len(parts) == 2 else ""
    except UnicodeError:
        domain = ""
    if (
        len(parts) != 2
        or len(local) > 64
        or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
        or len(domain.split(".")) < 2
        or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
            for part in domain.split(".")
        )
        or len(raw) > 254
    ):
        raise DomainError(422, "a valid email address is required")
    return local + "@" + domain

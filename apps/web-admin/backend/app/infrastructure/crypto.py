"""密码挑战、令牌及资源凭据格式；不承担业务授权。"""

import asyncio
import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.infrastructure.errors import DomainError


def encode(value: bytes) -> str:
    """URL 安全 Base64 保持现有客户端密码挑战表达。"""
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def digest(value: str) -> str:
    """不可逆收据摘要，明文刷新令牌不入库。"""
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password: str, salt: str | None = None) -> str:
    """与客户端 PBKDF2 SHA256、120000 次挑战保持互操作。"""
    salt = salt or secrets.token_urlsafe(16)
    verifier = encode(hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000))
    return f"pbkdf2_sha256${salt}${verifier}"


def verifier_hash(verifier: str, salt: str) -> str:
    """验证客户端提交的挑战摘要格式，不能接受任意替代口令。"""
    if not salt or "$" in salt or len(salt) > 128:
        raise ValueError("invalid password salt")
    decoded = base64.urlsafe_b64decode(verifier + "=" * (-len(verifier) % 4))
    if len(decoded) != 32 or encode(decoded) != verifier:
        raise ValueError("invalid password verifier")
    return f"pbkdf2_sha256${salt}${verifier}"


def verify_password(stored: str, password: str | None, verifier: str | None) -> bool:
    """常量时间比较；调用方仍需检查账号与登录会话状态。"""
    parts = stored.split("$")
    if len(parts) != 3:
        return False
    try:
        expected = (
            password_hash(password, parts[1])
            if password is not None
            else f"pbkdf2_sha256${parts[1]}${verifier or ''}"
        )
        # compare_digest的字符串模式只接纳ASCII；非法挑战必须验证失败，不能抛500或禁用正常中文密码。
        return hmac.compare_digest(stored.encode(), expected.encode())
    except UnicodeError:
        return False


class TokenCodec:
    """签名访问令牌仅用于关联数据库会话，撤销不依赖过期时间。"""

    def __init__(self, secret: str) -> None:
        self.secret = secret

    def issue(self, user_id: str, session_id: str, version: int) -> str:
        """签发短期访问令牌，版本取账号持久授权代际。"""
        return jwt.encode(
            {
                "sub": user_id,
                "sid": session_id,
                "ver": version,
                "exp": datetime.now(UTC) + timedelta(minutes=15),
            },
            self.secret,
            algorithm="HS256",
        )

    def decode(self, token: str) -> dict[str, object]:
        """严格限制算法并要求关联信息，错误统一由认证用例处理。"""
        return dict(
            jwt.decode(
                token,
                self.secret,
                algorithms=["HS256"],
                options={"require": ["sub", "sid", "ver", "exp"]},
            )
        )


class PasswordSecurity(TokenCodec):
    """密码计算移出事件循环，格式错误转换为稳定输入错误。"""

    async def hash_password(
        self, password: str | None, verifier: str | None, salt: str | None
    ) -> str:
        if password is not None:
            if not 8 <= len(password) <= 1024:
                raise DomainError(422, "password must contain 8 to 1024 characters")
            try:
                return await asyncio.to_thread(password_hash, password)
            except UnicodeError as error:
                raise DomainError(422, "invalid password encoding") from error
        try:
            return verifier_hash(verifier or "", salt or "")
        except (ValueError, TypeError) as error:
            raise DomainError(422, "invalid password verifier") from error

    async def verify(self, stored: str, password: str | None, verifier: str | None) -> bool:
        return await asyncio.to_thread(verify_password, stored, password, verifier)

    def hash_token(self, value: str) -> str:
        return digest(value)


class CredentialCipher:
    """AES-GCM 凭据绑定资源身份，跨资源挪用密文会校验失败。"""

    def __init__(self, key: str) -> None:
        raw = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))
        if len(raw) != 32:
            raise ValueError("加密密钥必须编码 32 字节")
        self.cipher = AESGCM(raw)

    def seal(self, value: str, identity: str) -> str:
        """只保存密文；调用者不可将结果连同明文记录到日志。"""
        nonce = secrets.token_bytes(12)
        return encode(nonce + self.cipher.encrypt(nonce, value.encode(), identity.encode()))

    def open(self, value: str, identity: str) -> str:
        """仅已授权工具执行路径使用，读取接口不得调用解密输出。"""
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        return self.cipher.decrypt(raw[:12], raw[12:], identity.encode()).decode()

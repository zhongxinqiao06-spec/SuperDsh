"""密码挑战边界保持正常Unicode口令有效，非法编码和挑战不能引发服务端错误。"""

import pytest

from app.infrastructure.crypto import PasswordSecurity, password_hash, verify_password
from app.infrastructure.errors import DomainError


@pytest.mark.parametrize("verifier", ["中文挑战", "\ud800", "invalid-" * 10])
def test_malformed_verifier_is_rejected_without_internal_error(verifier: str) -> None:
    """已存在账号的错误挑战只能验证失败，不进入ASCII比较异常。"""
    stored = password_hash("Synthetic-password-123!")
    assert not verify_password(stored, None, verifier)


async def test_unicode_password_and_valid_challenge_remain_supported() -> None:
    """UTF-8密码与客户端PBKDF2挑战必须保留两种合法验证路径。"""
    security = PasswordSecurity("synthetic-signing-key-at-least-32-characters")
    password = "合成中文密码-123!😀"
    stored = await security.hash_password(password, None, None)
    assert await security.verify(stored, password, None)
    assert await security.verify(stored, None, stored.split("$")[2])
    assert not await security.verify(stored, "其他中文密码-123!", None)


async def test_invalid_unicode_password_encoding_has_stable_input_error() -> None:
    """JSON转义可携带孤立代理码；注册明确拒绝，登录不能泄漏内部编码异常。"""
    security = PasswordSecurity("synthetic-signing-key-at-least-32-characters")
    with pytest.raises(DomainError) as failure:
        await security.hash_password("synthetic-\ud800", None, None)
    assert failure.value.status == 422
    assert not await security.verify(password_hash("Synthetic-password-123!"), "bad-\ud800", None)

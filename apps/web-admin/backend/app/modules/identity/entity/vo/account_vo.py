"""个人资料、恢复与移动登录的限长输入契约。"""

import re
from typing import Literal

from pydantic import Field, field_validator

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.validation import display_name, email_address
from app.modules.identity.entity.vo.dto import InputModel, PasswordInput


class ProfileInput(InputModel):
    displayName: str = Field(default="", validate_default=True)

    @field_validator("displayName", mode="before")
    @classmethod
    def normalize_name(cls, value: object) -> str:
        """资料保存使用旧端显示名称规则，不能把纯空白或控制字符持久化。"""
        return display_name(value)


class UsernameInput(InputModel):
    username: str = Field(pattern=r"^[a-z0-9_-]{3,32}$")


class AvatarInput(InputModel):
    avatar: str = Field(default="", validate_default=True)

    @field_validator("avatar", mode="before")
    @classmethod
    def image_data(cls, value: object) -> str:
        """先按旧协议去空白，再以413拒绝超限图片，避免通用DTO改写错误语义。"""
        value = value.strip() if isinstance(value, str) else ""
        if len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > 256 * 1024:
            raise DomainError(413, "avatar exceeds 256KB limit")
        if not re.fullmatch(r"data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+", value):
            raise DomainError(422, "invalid avatar image")
        return value


class EmailInput(InputModel):
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(default="", max_length=20)

    @field_validator("email")
    @classmethod
    def email_address(cls, value: str) -> str:
        return email_address(value)


class EmailCodeInput(EmailInput):
    email: str = Field(default="", max_length=254)
    purpose: str = Field(default="", max_length=32)
    pendingToken: str = Field(default="", max_length=512)
    setupToken: str = Field(default="", max_length=200)


class RecoveryInput(PasswordInput):
    identifier: str = Field(default="", max_length=254)
    recoveryCode: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=254)
    code: str = Field(default="", max_length=20)


class MobileInput(InputModel):
    loginToken: str = Field(default="", max_length=1024)
    userId: str = Field(default="", max_length=100)
    deviceName: str = Field(default="", max_length=80)
    approved: bool = False

    @field_validator("deviceName", mode="before")
    @classmethod
    def compatible_device_name(cls, value: object) -> object:
        """沿用现有移动端超长设备名称截断行为，不因展示字段阻断扫码。"""
        return value[:80] if isinstance(value, str) else value


class OAuthFinalizeInput(InputModel):
    pendingToken: str = Field(default="", max_length=1024)
    mode: Literal["link", "register", "auto"] = "auto"
    setPassword: bool = False
    identifier: str = Field(default="", max_length=254)
    password: str | None = Field(default=None, max_length=1024)
    passwordVerifier: str | None = Field(default=None, max_length=100)
    passwordSalt: str | None = Field(default=None, max_length=128)
    username: str = Field(default="", max_length=32, pattern=r"^(?:[a-z0-9_-]{3,32})?$")
    displayName: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=254)
    code: str = Field(default="", max_length=20)

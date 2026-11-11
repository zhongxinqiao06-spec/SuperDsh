"""系统设置输入契约；未知字段、非法地址及互斥凭据操作在边界拒绝。"""

from typing import Self
from urllib.parse import urlsplit

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.modules.identity.entity.vo.dto import InputModel


class OAuthSettings(InputModel):
    enabled: bool | None = None
    provider: str | None = Field(default=None, max_length=100)
    label: str | None = Field(default=None, max_length=100)
    clientId: str | None = Field(default=None, max_length=300)
    clientSecret: str | None = Field(default=None, max_length=4096)
    clearClientSecret: bool = False
    authorizeUrl: str | None = Field(default=None, max_length=2000)
    tokenUrl: str | None = Field(default=None, max_length=2000)
    userInfoUrl: str | None = Field(default=None, max_length=2000)
    scope: str | None = Field(default=None, max_length=500)
    scopes: str | None = Field(default=None, max_length=500)
    subjectClaim: str | None = Field(default=None, max_length=100)
    emailClaim: str | None = Field(default=None, max_length=100)
    nameClaim: str | None = Field(default=None, max_length=100)
    usernameClaim: str | None = Field(default=None, max_length=100)

    @field_validator("authorizeUrl", "tokenUrl", "userInfoUrl")
    @classmethod
    def safe_url(cls, value: str | None) -> str | None:
        if value:
            url = urlsplit(value)
            if (
                url.scheme not in {"http", "https"}
                or not url.hostname
                or url.username
                or url.password
            ):
                raise ValueError("invalid OAuth provider URL")
        return value


class EmailSettings(InputModel):
    enabled: bool | None = None
    fromAddress: str | None = Field(default=None, max_length=320)
    apiKey: str | None = Field(default=None, max_length=4096)
    clearApiKey: bool = False

    @model_validator(mode="after")
    def exclusive_key(self) -> Self:
        if self.clearApiKey and self.apiKey:
            raise ValueError("Cannot replace and clear the API key together")
        return self


class ServiceSettingsInput(InputModel):
    registrationOpen: bool | None = None
    oauthRegistrationOpen: bool | None = None
    oauth: OAuthSettings | None = None
    email: EmailSettings | None = None
    revision: int | None = Field(default=None, ge=0)


class AnnouncementInput(InputModel):
    enabled: bool
    markdown: str = Field(max_length=20000)
    revision: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def content_required(self) -> Self:
        if self.enabled and not self.markdown.strip():
            raise ValueError("announcement content is required")
        return self


class IntensityInput(InputModel):
    basis: str = "messages"
    lightMax: int = Field(default=10, ge=0)
    mediumMax: int = Field(default=50, ge=0)


class HistogramInput(InputModel):
    messages: list[int] = Field(default_factory=lambda: [0, 5, 20, 100], max_length=100)
    sessions: list[int] = Field(default_factory=lambda: [0, 1, 5, 20], max_length=100)

    @field_validator("messages", "sessions")
    @classmethod
    def normalized_bins(cls, value: list[int]) -> list[int]:
        if any(item < 0 for item in value):
            raise ValueError("histogram bins must be nonnegative")
        return sorted(set([0, *value]))


class DashboardSettingsInput(InputModel):
    intensity: IntensityInput = Field(default_factory=IntensityInput)
    histogramBins: HistogramInput = Field(default_factory=HistogramInput)


class DashboardSettingsPatchInput(InputModel):
    """局部更新保留字段是否提供的事实；数值与分区校验由纯业务规则统一执行。"""

    model_config = ConfigDict(extra="ignore")
    intensity: object = None
    histogramBins: object = None

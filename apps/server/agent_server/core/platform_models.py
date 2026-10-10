from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ModelProtocol = Literal["openai-completions", "openai-responses", "anthropic-messages"]


class PlatformModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    modelId: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    contextWindow: int | None = Field(default=None, gt=0)
    maxTokens: int | None = Field(default=None, gt=0)
    inputTypes: list[Literal["text", "image"]] = Field(default_factory=lambda: ["text"])


class ProviderWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    protocol: ModelProtocol
    baseUrl: str
    models: list[PlatformModel] = Field(min_length=1, max_length=100)
    enabled: bool = True
    apiKey: str | None = Field(default=None, max_length=8192)
    clearApiKey: bool = False

    @field_validator("baseUrl")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        parsed = urlsplit(value.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "baseUrl must be an HTTP(S) URL without credentials, query or fragment"
            )
        return value.strip().rstrip("/")

    @model_validator(mode="after")
    def distinct_models(self) -> ProviderWrite:
        if len({item.modelId for item in self.models}) != len(self.models):
            raise ValueError("model IDs must be unique within a provider")
        if self.clearApiKey and self.apiKey:
            raise ValueError("apiKey and clearApiKey cannot be supplied together")
        return self


class ProviderView(BaseModel):
    providerId: str
    name: str
    protocol: ModelProtocol
    baseUrl: str
    models: list[PlatformModel]
    enabled: bool
    apiKeyConfigured: bool
    createdAt: str
    updatedAt: str
    source: Literal["personal", "platform"] = "platform"


class ModelSelection(BaseModel):
    providerId: str
    modelId: str


class DefaultWrite(BaseModel):
    selection: ModelSelection | None = None

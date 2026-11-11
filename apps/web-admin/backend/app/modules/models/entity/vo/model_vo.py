"""保持既有模型字段和密钥保留语义的严格输入契约。"""

from typing import Literal, Self
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

Protocol = Literal["openai-completions", "openai-responses", "anthropic-messages"]
Adapter = Literal[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "volcengine-ark",
    "volcengine-speech",
]
Capability = Literal[
    "chat",
    "image.generate",
    "vision.analyze",
    "speech.transcribe",
    "speech.synthesize",
    "video.generate",
    "embedding",
]


class ModelInput(BaseModel):
    """拒绝未知输入，防止配置编辑携带授权或密文字段。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    @field_validator("name", "modelId", "providerId", "connectionId", check_fields=False)
    @classmethod
    def named_value(cls, value: str) -> str:
        """名称和资源标识统一去首尾空白，禁止空名称及控制字符。"""
        value = value.strip()
        if not value or any(ord(character) < 32 for character in value):
            raise ValueError("名称或资源标识不合法")
        return value


def canonical_address(value: str) -> str:
    """供应商地址不能夹带用户凭据、查询或片段。"""
    parsed = urlsplit(value.strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("供应商地址必须为无凭据、查询和片段的 HTTP(S) 地址")
    return value.strip().rstrip("/")


def default_input_types() -> list[Literal["text", "image"]]:
    """默认聊天输入为文本，图像输入必须显式声明。"""
    return ["text"]


class ModelDefinitionInput(ModelInput):
    """单个聊天模型与客户端目录使用相同字段。"""

    modelId: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    contextWindow: int | None = Field(default=None, gt=0)
    maxTokens: int | None = Field(default=None, gt=0)
    inputTypes: list[Literal["text", "image"]] = Field(default_factory=default_input_types)


class ProviderInput(ModelInput):
    """省略或空密钥保留原值，clearApiKey 才显式删除。"""

    name: str = Field(min_length=1, max_length=100)
    protocol: Protocol
    baseUrl: str = Field(max_length=2048)
    models: list[ModelDefinitionInput] = Field(min_length=1, max_length=100)
    enabled: bool = True
    apiKey: SecretStr | None = None
    clearApiKey: bool = False

    _address = field_validator("baseUrl")(canonical_address)

    @model_validator(mode="after")
    def valid_models(self) -> Self:
        """重复模型与同时清空/写入密钥都属于输入冲突。"""
        if len({model.modelId for model in self.models}) != len(self.models):
            raise ValueError("同一供应商的模型标识不能重复")
        if self.apiKey and (len(self.apiKey.get_secret_value()) > 8192 or self.clearApiKey):
            raise ValueError("密钥长度或清空选项无效")
        return self


class Selection(ModelInput):
    """模型选择只引用已经授权的供应商和模型。"""

    providerId: str = Field(min_length=1, max_length=100)
    modelId: str = Field(min_length=1, max_length=200)


class DefaultInput(ModelInput):
    selection: Selection | None = None


class ConnectionInput(ModelInput):
    name: str = Field(min_length=1, max_length=100)
    adapter: Adapter
    baseUrl: str = Field(max_length=2048)
    region: str = Field(default="", max_length=100)
    revision: int | None = Field(default=None, ge=1)
    enabled: bool = True
    apiKey: SecretStr | None = None
    clearApiKey: bool = False
    _address = field_validator("baseUrl")(canonical_address)

    @model_validator(mode="after")
    def valid_key(self) -> Self:
        if self.apiKey and (len(self.apiKey.get_secret_value()) > 8192 or self.clearApiKey):
            raise ValueError("密钥长度或清空选项无效")
        return self


class ConfigurationInput(ModelInput):
    name: str = Field(min_length=1, max_length=100)
    connectionId: str = Field(min_length=1, max_length=100)
    capability: Capability
    modelId: str = Field(min_length=1, max_length=200)
    revision: int | None = Field(default=None, ge=1)
    enabled: bool = True
    parameters: dict[str, object] = Field(default_factory=dict)
    roleIds: list[str] = Field(default_factory=list, max_length=100)


class CapabilityDefaultInput(ModelInput):
    configurationId: str | None = None
    revision: int = Field(ge=0)


class CapabilityBinding(ModelInput):
    configurationId: str = Field(min_length=1, max_length=100)
    revision: int = Field(ge=1)
    capability: Capability

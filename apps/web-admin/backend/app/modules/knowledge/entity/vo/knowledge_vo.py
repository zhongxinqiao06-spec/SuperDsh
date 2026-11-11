"""知识库、索引和语义配置输入，版本比较防止管理员互相覆盖。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.modules.agents.entity.vo.agent_vo import AgentInput
from app.modules.models.entity.vo.model_vo import canonical_address


class KnowledgeInputBase(BaseModel):
    """未知字段拒绝写入，避免配置变成无约束 JSON。"""

    model_config = ConfigDict(extra="forbid", strict=True)


class KnowledgeInput(KnowledgeInputBase):
    """知识库仅绑定可追溯资料身份，不保存任意磁盘路径。"""

    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    assetIds: list[str] = Field(default_factory=list, max_length=100)
    enabled: bool = True
    version: int | None = Field(default=None, ge=1)

    @field_validator("assetIds")
    @classmethod
    def valid_ids(cls, value: list[str]) -> list[str]:
        """复用标识规则时显式调用，避免重复绑定 Pydantic 类方法。"""
        return AgentInput.valid_ids(value)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        """名称不能只含空白。"""
        return AgentInput.required_text(value)


class IndexInput(KnowledgeInputBase):
    """不传 assetId 时重建当前知识库的全部资料。"""

    assetId: str | None = Field(default=None, min_length=1, max_length=100)


class SearchInput(KnowledgeInputBase):
    """检索输入限制在语义编码器允许的范围。"""

    query: str = Field(min_length=1, max_length=200)

    @field_validator("query")
    @classmethod
    def valid_query(cls, value: str) -> str:
        """空白问题不能触发编码请求。"""
        return AgentInput.required_text(value)


class RestoreInput(KnowledgeInputBase):
    """回退新增修订，需要目标与当前版本。"""

    sourceVersion: int = Field(ge=1)
    version: int = Field(ge=1)


class EmbeddingInput(KnowledgeInputBase):
    """外部服务凭据保留或清空必须显式表达。"""

    kind: Literal["local", "openai-compatible"]
    version: int = Field(ge=0)
    model: str = Field(default="", max_length=200)
    dimensions: int = Field(default=512, ge=1, le=4096)
    revision: str = Field(default="", max_length=100)
    baseUrl: str = Field(default="", max_length=2048)
    apiKey: SecretStr | None = None
    clearApiKey: bool = False

    @field_validator("baseUrl")
    @classmethod
    def valid_address(cls, value: str) -> str:
        """本地模式不需要地址；外部模式在服务层检查完整配置。"""
        return canonical_address(value) if value else ""

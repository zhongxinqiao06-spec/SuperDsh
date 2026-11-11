"""智能体声明式组合和资产上传输入，不将场景名称写入执行逻辑。"""

import re
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AgentInputBase(BaseModel):
    """已知字段严格解析，隐藏身份与存储字段不能通过请求覆盖。"""

    model_config = ConfigDict(extra="forbid", strict=True)


class SkillPolicyInput(AgentInputBase):
    """阶段技能的选择策略，固定模式必须引用已绑定技能。"""

    mode: Literal["legacy", "auto", "fixed"]
    fixedSkillId: str | None = Field(default=None, max_length=160)

    @model_validator(mode="after")
    def valid_fixed(self) -> Self:
        """固定模式不能省略具体技能。"""
        if self.mode == "fixed" and not self.fixedSkillId:
            raise ValueError("固定策略需要技能标识")
        if self.mode != "fixed":
            self.fixedSkillId = None
        return self


class AgentInput(AgentInputBase):
    """维护旧智能体 DTO 的名称、提示词、资源及发布状态。"""

    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    instructions: str = Field(min_length=1, max_length=6000)
    recommendedPrompts: list[str] = Field(default_factory=list, max_length=8)
    inputRequirements: list[str] = Field(default_factory=list, max_length=12)
    outputExamples: list[str] = Field(default_factory=list, max_length=8)
    knowledgeBaseIds: list[str] = Field(default_factory=list, max_length=20)
    knowledgeAssetIds: list[str] = Field(default_factory=list, max_length=20)
    templateAssetIds: list[str] = Field(default_factory=list, max_length=20)
    skillIds: list[str] = Field(default_factory=list, max_length=20)
    toolIds: list[str] = Field(default_factory=list, max_length=20)
    skillPolicy: SkillPolicyInput | None = None
    published: bool
    version: int | None = Field(default=None, ge=1)

    @field_validator("name", "instructions")
    @classmethod
    def required_text(cls, value: str) -> str:
        """空白不构成可发布的名称或任务说明。"""
        if not value.strip():
            raise ValueError("名称和任务说明不能为空")
        return value.strip()

    @field_validator(
        "knowledgeBaseIds", "knowledgeAssetIds", "templateAssetIds", "skillIds", "toolIds"
    )
    @classmethod
    def valid_ids(cls, value: list[str]) -> list[str]:
        """引用不允许重复或夹带路径。"""
        if len(set(value)) != len(value) or any(
            not re.fullmatch(r"[\w.-]{1,100}", item) for item in value
        ):
            raise ValueError("资源标识无效或重复")
        return value

    @field_validator("recommendedPrompts", "inputRequirements", "outputExamples")
    @classmethod
    def valid_lines(cls, value: list[str]) -> list[str]:
        """每条说明最多五百字，避免无界提示输入。"""
        if any(not item.strip() or len(item) > 500 for item in value):
            raise ValueError("说明不能为空且每条最多 500 字")
        return [item.strip() for item in value]


class AssetInput(AgentInputBase):
    """资产保留旧 Base64 合同，文件域负责存储，解析失败不保存资产。"""

    name: str = Field(min_length=1, max_length=150)
    kind: Literal["knowledge", "spreadsheet-template", "presentation-template", "document-template"]
    contentBase64: str = Field(min_length=1, max_length=6 * 1024 * 1024)

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        """显示文件名不允许控制字符或路径分隔符。"""
        if re.search(r"[\\/\x00-\x1f]", value) or value in {".", ".."}:
            raise ValueError("文件名不能包含路径")
        return value


class InitializeInput(AgentInputBase):
    """显式复制最新版创建独立副本；普通初始化不覆盖用户修改。"""

    copyLatest: bool = False

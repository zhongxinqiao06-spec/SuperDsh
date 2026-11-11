"""已有外部会话的导入输入，与发送第一条消息的执行请求分离。"""

from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.infrastructure.input_validation import required_text


class ImportSessionInput(BaseModel):
    """导入不要求消息幂等键；显式提供时仍验证完整请求身份。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    externalSessionId: str = Field(default="", validate_default=True)
    connectorId: str = Field(min_length=1, max_length=100)
    projectId: str = Field(min_length=1, max_length=100)
    runtime: str = Field(default="dsh", min_length=1, max_length=100)
    runtimeId: str = Field(default="dsh", min_length=1, max_length=100)
    cwd: str | None = Field(default=None, max_length=4096)
    title: str | None = Field(default=None, max_length=500)
    selections: dict[str, object] = Field(default_factory=dict)
    clientMessageId: str | None = Field(default=None, max_length=128)
    agentDefinitionId: str | None = Field(default=None, max_length=100)

    @field_validator("externalSessionId", mode="before")
    @classmethod
    def external_identifier(cls, value: object) -> str:
        """缺少外部身份必须引导调用执行入口，不能偷偷创建一个空白新会话。"""
        return required_text(
            value, "externalSessionId; new sessions must use /sessions/create-and-start"
        )

    @model_validator(mode="after")
    def runtime_identifier(self) -> Self:
        """旧客户端只传运行类型时，该类型同时作为运行实例标识。"""
        if "runtimeId" not in self.model_fields_set:
            self.runtimeId = self.runtime
        return self

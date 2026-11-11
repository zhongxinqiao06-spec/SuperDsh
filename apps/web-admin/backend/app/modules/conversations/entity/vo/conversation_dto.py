"""会话输入保留旧字段与稳定操作标识。"""

from typing import Self

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    connectorId: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=255)
    workspacePath: str = Field(min_length=1, max_length=4096)
    # Android 的自动项目必须保留 false，否则空项目的侧栏可见性会改变。
    manuallyCreated: bool = True


class CreateSessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    connectorId: str = Field(min_length=1, max_length=100)
    projectId: str | None = Field(default=None, max_length=100)
    runtimeId: str = Field(default="dsh", min_length=1, max_length=100)
    runtime: str = Field(default="dsh", min_length=1, max_length=100)
    cwd: str | None = Field(default=None, max_length=4096)
    title: str = Field(default="新会话", min_length=1, max_length=500)
    text: str = Field(
        default="", max_length=1000000, validation_alias=AliasChoices("text", "content")
    )
    clientMessageId: str = Field(min_length=1, max_length=128)
    agentDefinitionId: str | None = Field(default=None, max_length=100)
    attachments: list[dict[str, object]] = Field(default_factory=list, max_length=32)
    selections: dict[str, object] = Field(default_factory=dict)
    runtimeOptions: dict[str, object] = Field(default_factory=dict)

    @model_validator(mode="after")
    def runtime_identifier(self) -> Self:
        """Android省略与运行类型同名的runtimeId时，保持原客户端目标实例语义。"""
        if "runtimeId" not in self.model_fields_set:
            self.runtimeId = self.runtime
        return self


class MessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(
        default="", max_length=1000000, validation_alias=AliasChoices("text", "content")
    )
    clientMessageId: str = Field(min_length=1, max_length=128)
    attachments: list[dict[str, object]] = Field(default_factory=list, max_length=32)
    selections: dict[str, object] = Field(default_factory=dict)
    runtimeOptions: dict[str, object] = Field(default_factory=dict)


class TicketInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    clientId: str = Field(min_length=1, max_length=160)
    scope: dict[str, object]

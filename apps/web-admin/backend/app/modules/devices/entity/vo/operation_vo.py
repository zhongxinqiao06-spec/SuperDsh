"""设备文件预览与 Shell 操作的有界请求契约。"""

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.infrastructure.input_validation import required_text


class PreviewExchange(BaseModel):
    """一次性预览令牌只兑换限定路径的短期访问会话。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    previewToken: str = Field(default="", validate_default=True)

    @field_validator("previewToken", mode="before")
    @classmethod
    def valid_token(cls, value: object) -> str:
        """公开兑换接口先返回稳定字段错误，再进入授权校验。"""
        return required_text(value, "previewToken")


class PreviewRead(BaseModel):
    """访问令牌不能由请求覆盖根路径、文件路径或所有者。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    previewAccessToken: str = Field(default="", validate_default=True)
    maxBytes: int = Field(default=1048576, ge=1, le=4194304)

    @field_validator("previewAccessToken", mode="before")
    @classmethod
    def valid_token(cls, value: object) -> str:
        """文件范围仍由服务端票据决定，不信任请求附带的路径。"""
        return required_text(value, "previewAccessToken")


class ShellInput(BaseModel):
    """Shell 是用户明确发起的设备操作，不参与 Agent 任务调度。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    command: str = Field(min_length=1, max_length=32768)
    root: str | None = Field(default=None, max_length=4096)
    cwd: str = Field(default=".", max_length=4096)
    timeoutMs: int = Field(default=30000, ge=1, le=300000)
    env: dict[str, str] = Field(default_factory=dict, max_length=100)
    operationId: str | None = Field(default=None, pattern=r"^[\w-]{1,100}$")

    @field_validator("command", "cwd", "root")
    @classmethod
    def no_null(cls, value: str | None) -> str | None:
        """控制字符不进入进程或路径 API；命令允许常规换行。"""
        if value is not None and "\x00" in value:
            raise ValueError("参数包含不允许的空字符")
        return value

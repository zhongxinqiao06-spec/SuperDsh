"""运行入口 DTO 只描述输入，不读取数据库、文件或外部系统。"""

from pydantic import BaseModel, ConfigDict, Field


class SessionMessage(BaseModel):
    """显式会话、幂等消息和配置选择；不接受 Host 路径或隐式默认模型。"""

    model_config = ConfigDict(extra="forbid")
    sessionId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    clientMessageId: str = Field(min_length=1, max_length=128)
    content: str = Field(min_length=1, max_length=1_000_000)
    selections: dict[str, str] = Field(default_factory=dict)
    agentPreset: str | None = Field(default=None, max_length=128)

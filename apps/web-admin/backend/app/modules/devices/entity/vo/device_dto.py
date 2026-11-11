"""设备与配对输入沿用客户端字段，在边界拒绝无效参数。"""

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from app.infrastructure.input_validation import required_text


class DeviceInput(BaseModel):
    """设备命名与平台元数据不包含可由客户端指定的所有者。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(default="SuperDsh Connector", min_length=1, max_length=255)
    connectorKind: str = Field(default="cli", max_length=50)
    executorKind: str = Field(default="desktop", max_length=50)
    deviceOs: str | None = Field(default=None, max_length=50)
    installationId: str | None = Field(default=None, max_length=4096)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if not value.strip() or any(ord(character) < 32 for character in value):
            raise ValueError("设备名称不合法")
        return value.strip()


class PairingStart(BaseModel):
    """短期配对码只绑定服务地址，不授予设备身份。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    ttlSeconds: int = Field(default=300, ge=30, le=900)
    serverUrl: str | None = Field(default=None, max_length=2000)


class PairingClaim(DeviceInput):
    """领取端必须已经登录，旧设备重连需要同时证明原凭据。"""

    code: str = Field(pattern=r"^\d{6}$")
    connectorId: str | None = Field(default=None, max_length=100)
    connectorToken: str | None = Field(default=None, max_length=256)
    # Android附带当前服务地址；配对结果仍使用start时冻结的地址，不能由领取者改写。
    serverUrl: str | None = Field(default=None, max_length=2000)


class PairingPoll(BaseModel):
    """随机配对身份与短验证码分离，明文凭据仅可消费一次。"""

    pairingId: str = Field(default="", validate_default=True)

    @field_validator("pairingId", mode="before")
    @classmethod
    def valid_pairing_id(cls, value: object) -> str:
        """字段形态和票据有效性分别验证，短但非空的未知票据由用例判定。"""
        return required_text(value, "pairingId")


class DevicePatch(BaseModel):
    """仅允许修改用户可编辑的设备名称。"""

    name: str = Field(min_length=1, max_length=255)


class RuntimeInput(BaseModel):
    """远端运行实例配置由设备目录定义，平台不执行第二套引擎。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    runtimeId: str | None = Field(default=None, max_length=100)
    runtimeType: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=128)
    config: dict[str, object] | None = None
    active: bool = False


class FileRequest(BaseModel):
    """路径限定到设备授权工作区，写入支持内容条件保护。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    path: str = Field(default=".", min_length=1, max_length=4096)
    root: str | None = Field(default=None, max_length=4096)
    content: str | None = Field(default=None, max_length=4 * 1024 * 1024)
    ifMatch: str | None = Field(default=None, max_length=100)
    encoding: str | None = None
    maxBytes: int = Field(default=1024 * 1024, ge=1, le=64 * 1024 * 1024)


class TerminalInput(BaseModel):
    """保留设备终端启动参数；归属、工作区及终端身份由服务覆盖，客户端不能指定。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    cols: int = Field(default=80, ge=1, le=500)
    rows: int = Field(default=24, ge=1, le=200)
    cwd: str = Field(default=".", max_length=4096)
    root: str | None = Field(default=None, max_length=4096)
    name: str = Field(
        default="Shell",
        min_length=1,
        max_length=100,
        validation_alias=AliasChoices("label", "name"),
        serialization_alias="label",
    )
    sessionId: str | None = Field(default=None, max_length=100)
    persistence: bool = Field(
        default=False,
        validation_alias=AliasChoices("persistent", "persistence"),
        serialization_alias="persistent",
    )
    shell: str | None = Field(default=None, min_length=1, max_length=4096)
    args: list[str] | None = Field(default=None, max_length=256)
    command: str | None = Field(default=None, max_length=64 * 1024)
    env: dict[str, str] | None = None
    profile: str | None = Field(default=None, max_length=200)
    ephemeralGroupId: str | None = Field(default=None, max_length=200)

    @field_validator("args")
    @classmethod
    def valid_arguments(cls, value: list[str] | None) -> list[str] | None:
        """原生旧设备要求每个显式参数为非空文本，保留空参数列表的明确含义。"""
        if value is not None and any(not item.strip() or len(item) > 4096 for item in value):
            raise ValueError("terminal argument is required or invalid")
        return value

    @field_validator("shell", "args", "command", "env")
    @classmethod
    def valid_process_text(cls, value: object) -> object:
        """拒绝操作系统无法接收的NUL及超限参数；不把参数拼成另一层shell命令。"""
        values = (
            list(value.keys()) + list(value.values())
            if isinstance(value, dict)
            else value
            if isinstance(value, list)
            else [value]
            if isinstance(value, str)
            else []
        )
        if len(values) > 512 or any(
            isinstance(item, str) and ("\x00" in item or len(item) > 64 * 1024) for item in values
        ):
            raise ValueError("终端启动参数无效")
        return value

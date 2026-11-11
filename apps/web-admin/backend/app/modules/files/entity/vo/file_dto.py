"""文件与存储接口输入，兼容现有客户端字段并拒绝路径注入。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class FileInput(BaseModel):
    """文件用例输入不允许未知字段批量赋值。"""

    model_config = ConfigDict(extra="forbid", strict=True)


class UploadInput(FileInput):
    """分片上传前冻结声明大小、摘要和幂等身份。"""

    name: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=1, le=1024 * 1024 * 1024)
    sha256: str = Field(pattern="^[a-fA-F0-9]{64}$")
    mediaType: str = Field(default="application/octet-stream", max_length=200)
    idempotencyKey: str = Field(min_length=1, max_length=160)
    previousFileId: str | None = Field(default=None, max_length=100)

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        """用户名称仅用于展示，不参与本地对象路径生成。"""
        value = value.strip()
        if (
            not value
            or value in {".", ".."}
            or any(char in value for char in "/\\")
            or any(ord(char) < 32 for char in value)
        ):
            raise ValueError("文件名不能包含路径或控制字符")
        return value


class StorageConfiguration(FileInput):
    """管理员可配 S3，不允许通过接口切换任意本地目录。"""

    backend: Literal["s3"]
    endpoint: str = Field(min_length=1, max_length=2000)
    bucket: str = Field(min_length=3, max_length=63, pattern=r"^[a-z0-9][a-z0-9.-]+[a-z0-9]$")
    region: str = Field(default="us-east-1", max_length=80)
    prefix: str = Field(default="", max_length=200)
    virtualHostStyle: bool = False


class StorageCredentials(FileInput):
    """空对象保留旧密钥；显式空字段不会伪装成成功连接。"""

    accessKeyId: str = Field(min_length=1, max_length=256)
    secretAccessKey: str = Field(min_length=1, max_length=2048)
    sessionToken: str | None = Field(default=None, max_length=4096)


class ConnectionInput(FileInput):
    name: str = Field(min_length=1, max_length=100)
    configuration: StorageConfiguration
    credentials: StorageCredentials | None = None
    enabled: bool = True
    revision: int | None = Field(default=None, ge=1)


class StoragePolicy(FileInput):
    maxFileBytes: int = Field(default=32 * 1024 * 1024, ge=1, le=1024 * 1024 * 1024)
    temporaryHours: int = Field(default=24, ge=1, le=720)
    recycleDays: int = Field(default=30, ge=1, le=3650)


class SettingsInput(FileInput):
    activeConnectionId: str = Field(min_length=1, max_length=100)
    policy: StoragePolicy
    revision: int = Field(ge=1)

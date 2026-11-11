"""新平台独立配置；不读取旧平台环境文件或猜测数据库。"""

from datetime import datetime
from pathlib import Path
from typing import Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """显式注入数据库、密钥和持久目录；开发与生产均使用同一验证。"""

    model_config = SettingsConfigDict(env_prefix="WEB_ADMIN_", extra="ignore")
    database_url: str
    secret: SecretStr
    encryption_key: SecretStr
    data_dir: Path
    redis_url: str = "redis://localhost:16380/0"
    public_origin: str = "http://localhost:5175"
    allowed_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5175"])
    setup_token: SecretStr = SecretStr("")
    setup_token_expires_at: str | None = None
    # 初始账号仅用于空库启动，账号和密码由部署配置同时注入。
    initial_admin_username: str = Field(default="", pattern=r"^(?:[a-z0-9_-]{3,32})?$")
    initial_admin_password: SecretStr = SecretStr("")
    initial_admin_display_name: str = Field(default="", max_length=100)
    repository_root: Path = Path(__file__).resolve().parents[5]
    node_executable: str = "node"
    validation_dir: Path | None = None
    static_dir: Path | None = None
    use_langgraph: bool = False
    # 外部模型/MCP地址白名单只从部署注入，浏览器不能扩大网络访问边界。
    provider_allowed_origins: str = ""
    # 默认始终读取后端自身 config，不随 cwd 或 WEB_ADMIN_CONFIG_ROOT 改到工作目录。
    model_defaults_file: Path | None = (
        Path(__file__).resolve().parents[2] / "config/model-defaults.json"
    )
    embedding_trusted_origins: str = ""
    embedding_default: dict[str, object] | None = Field(
        default=None, validation_alias="SUPERDSH_KNOWLEDGE_EMBEDDING_DEFAULT"
    )
    qdrant_url: str = "http://localhost:56334"
    qdrant_api_key: SecretStr = SecretStr("")
    office_executable: str = ""
    office_native_manifest: Path | None = None
    runtime_state_root: Path | None = None
    compatibility_path: Path = (
        Path(__file__).resolve().parents[3] / "deployment" / "compatibility-routes.json"
    )

    @field_validator("database_url")
    @classmethod
    def postgres_only(cls, value: str) -> str:
        """拒绝隐式 SQLite 或旧默认库，业务闭环必须使用 PostgreSQL。"""
        if value.startswith("postgresql://"):
            value = value.replace("postgresql://", "postgresql+asyncpg://", 1)
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("必须显式配置 PostgreSQL asyncpg URL")
        return value

    @field_validator("secret")
    @classmethod
    def strong_secret(cls, value: SecretStr) -> SecretStr:
        """签名密钥至少 32 字节，不允许部署示例值成为默认身份。"""
        if len(value.get_secret_value()) < 32:
            raise ValueError("登录签名密钥至少 32 字符")
        return value

    @field_validator("initial_admin_password")
    @classmethod
    def valid_initial_password(cls, value: SecretStr) -> SecretStr:
        """初始密码沿用身份模块长度约束，错误信息不包含凭据内容。"""
        password = value.get_secret_value()
        if password and not 8 <= len(password) <= 1024:
            raise ValueError("初始管理员密码必须为 8 至 1024 字符")
        return value

    @model_validator(mode="after")
    def complete_initial_admin(self) -> Self:
        """允许关闭自动初始化，但不接受只有账号或只有密码的半套配置。"""
        if bool(self.initial_admin_username) != bool(
            self.initial_admin_password.get_secret_value()
        ):
            raise ValueError("初始管理员账号和密码必须同时配置")
        return self

    @field_validator("data_dir")
    @classmethod
    def absolute_data(cls, value: Path) -> Path:
        """持久目录使用绝对路径，避免不同启动目录意外共用 Home。"""
        if not value.is_absolute():
            raise ValueError("数据目录必须是绝对路径")
        return value

    @field_validator("setup_token_expires_at")
    @classmethod
    def absolute_expiry(cls, value: str | None) -> str | None:
        """初始化时效来自持久配置，要求带时区，避免本地时钟解释歧义。"""
        if value is not None and datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("初始化令牌到期时间必须带时区")
        return value

    @field_validator("public_origin")
    @classmethod
    def canonical_origin(cls, value: str) -> str:
        """Cookie 和 OAuth 来源不信任转发头，只接受明确配置的纯 origin。"""
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("公共地址必须是无凭据和路径的 HTTP origin")
        return value.rstrip("/")

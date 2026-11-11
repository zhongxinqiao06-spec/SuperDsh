"""扩展安装、MCP授权与工具配置的严格请求边界。"""

from pydantic import Field

from app.modules.identity.entity.vo.dto import InputModel


class ImplementationRef(InputModel):
    """稳定来源、版本与哈希共同确定执行实现。"""

    sourceId: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$")
    version: str = Field(min_length=1, max_length=100)
    toolId: str = Field(min_length=1, max_length=100)
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class ToolInput(InputModel):
    """工具配置可独立启停，writeOnly凭据只在服务端合并和加密。"""

    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    enabled: bool = True
    version: int | None = Field(default=None, ge=1)
    implementation: ImplementationRef
    settings: dict[str, object] = Field(default_factory=dict)


class InstallInput(InputModel):
    """仅接受有界归档，安装依赖时使用包内锁文件。"""

    contentBase64: str = Field(min_length=1, max_length=23 * 1024 * 1024)
    revision: int | None = Field(default=None, ge=1)
    expectedSourceId: str | None = Field(default=None, max_length=100)


class McpDiscoveryInput(InputModel):
    """凭据只可沿用同一端点，发现不等于授权执行。"""

    id: str | None = Field(default=None, max_length=100)
    endpoint: str = Field(min_length=1, max_length=2048)
    token: str | None = Field(default=None, max_length=8192)


class McpConnectInput(McpDiscoveryInput):
    """用户确认发现摘要及工具集合后才能保存来源版本。"""

    id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$")
    name: str = Field(min_length=1, max_length=100)
    version: str = Field(pattern=r"^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$")
    discoveryDigest: str = Field(pattern=r"^[a-f0-9]{64}$")
    selectedToolIds: list[str] = Field(min_length=1, max_length=200)
    revision: int | None = Field(default=None, ge=1)


class SourceUpdateInput(InputModel):
    """启用或回滚前重新检查固定版本，禁用立即撤销后续调用。"""

    revision: int = Field(ge=1)
    enabled: bool
    version: str = Field(min_length=1, max_length=100)


class SourceCheckInput(InputModel):
    """健康检查只针对已安装的不可变版本。"""

    version: str = Field(default="", max_length=100)

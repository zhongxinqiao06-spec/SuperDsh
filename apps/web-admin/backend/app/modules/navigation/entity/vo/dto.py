"""菜单请求 DTO。"""

from pydantic import Field

from app.modules.identity.entity.vo.dto import InputModel


class MenuInput(InputModel):
    """菜单更新必须携带当前配置版本。"""

    version: int = Field(ge=1)
    items: list[dict[str, object]] = Field(default_factory=list, max_length=128)


class MenuResetInput(InputModel):
    """恢复默认只要求当前版本，不让客户端提交另一份默认菜单。"""

    version: int = Field(ge=1)

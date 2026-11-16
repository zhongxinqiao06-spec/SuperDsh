"""产品管理员可提交、可读取的成员字段与分页契约。"""

from typing import TypedDict

from pydantic import Field

from app.modules.identity.entity.vo.dto import InputModel


class MembershipInput(InputModel):
    """授予普通成员身份时只接受已知账号标识，不接受角色或全局账号属性。"""

    identifier: str = Field(min_length=1, max_length=254)


class ProductMember(TypedDict):
    userId: str
    username: str
    displayName: str | None
    roleIds: list[str]
    removable: bool
    revision: int

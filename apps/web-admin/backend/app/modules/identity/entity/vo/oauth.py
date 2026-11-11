"""OAuth 对外字段沿用标准 snake_case。"""

from pydantic import Field

from .dto import InputModel


class AuthorizeInput(InputModel):
    """只支持授权码和 S256，回调白名单由服务层检查。"""

    client_id: str = Field(max_length=100)
    redirect_uri: str = Field(max_length=2048)
    code_challenge: str = Field(max_length=128)
    code_challenge_method: str = "S256"
    response_type: str = ""
    state: str = Field(default="", max_length=2048)
    scope: str = Field(default="", max_length=1000)

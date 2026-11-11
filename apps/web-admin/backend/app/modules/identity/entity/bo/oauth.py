"""OAuth 授权码业务值对象。"""

from dataclasses import dataclass
from datetime import datetime


@dataclass
class OAuthGrant:
    """授权码绑定当前登录会话，不能跨账号或回调换取令牌。"""

    code_hash: str
    user_id: str
    session_id: str
    auth_version: int
    client_id: str
    redirect_uri: str
    challenge: str
    expires_at: datetime
    scope: str

    consumed_at: datetime | None = None

"""新库身份表，内部存储结构不改变对外 camelCase 契约。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class UserRow(Base):
    """账号授权代际与编辑 revision 分别解决令牌撤销和并发覆盖。"""

    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    roles: Mapped[list[str]] = mapped_column(JSONB)
    email: Mapped[str | None] = mapped_column(String(254), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(100))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reset_required: Mapped[bool] = mapped_column(Boolean, default=False)
    auth_version: Mapped[int] = mapped_column(Integer, default=0)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 账户扩展用例可直接更新 ORM，统一维护更新时间，供旧客户端增量展示使用。
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=func.now(), onupdate=func.now()
    )


class RoleRow(Base):
    """角色配置与权限集合，不把内置管理员当全库内容通行证。"""

    __tablename__ = "roles"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    permissions: Mapped[list[str]] = mapped_column(JSONB)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)


class SessionRow(Base):
    """刷新令牌只保存摘要，串行轮换阻止并发复用。"""

    __tablename__ = "auth_sessions"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    refresh_hash: Mapped[str] = mapped_column(String(64))
    previous_refresh_hash: Mapped[str | None] = mapped_column(String(64))
    auth_version: Mapped[int] = mapped_column(Integer)
    client_name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditRow(Base):
    """只存脱敏管理事实，不保存令牌、密码或模型密钥。"""

    __tablename__ = "identity_audit"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    actor_id: Mapped[str | None] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(100))
    target_id: Mapped[str] = mapped_column(String(100))
    detail: Mapped[dict[str, object]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OAuthCodeRow(Base):
    """一次性 OAuth PKCE 授权码绑定原登录会话与回调身份。"""

    __tablename__ = "oauth_codes"
    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    session_id: Mapped[str] = mapped_column(ForeignKey("auth_sessions.id"))
    auth_version: Mapped[int] = mapped_column(Integer)
    client_id: Mapped[str] = mapped_column(String(100))
    redirect_uri: Mapped[str] = mapped_column(Text)
    challenge: Mapped[str] = mapped_column(String(43))
    scope: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

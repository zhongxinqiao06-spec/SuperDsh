"""沿用客户端字段，所有输入在协议边界限制类型及长度。"""

from datetime import UTC, datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.identity.entity.bo.models import Account, Role
from app.modules.identity.entity.bo.validation import email_address


class InputModel(BaseModel):
    """拒绝未声明字段，避免批量赋值越权。"""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)


class PasswordSaltInput(InputModel):
    """挑战只读取登录定位字段，忽略旧客户端附带字段，不将其映射到实体。"""

    model_config = ConfigDict(extra="ignore")

    identifier: str = ""
    email: str = ""

    @field_validator("identifier", "email", mode="before")
    @classmethod
    def compatible_identifier(cls, value: object) -> str:
        """旧text转换对空值和非字符串返回空串，由用例返回稳定登录错误。"""
        return value if isinstance(value, str) else ""


class LoginInput(PasswordSaltInput):
    """登录只接受白名单字段并忽略扩展元数据；其他写入DTO仍严格拒绝额外字段。"""

    password: str | None = None
    passwordVerifier: str | None = None
    clientType: str = "browser"
    clientName: str = "Browser"

    @field_validator("password", "passwordVerifier", mode="before")
    @classmethod
    def compatible_credential(cls, value: object) -> str | None:
        """非法凭据进入统一认证失败，不能因DTO类型泄漏额外身份判断。"""
        return value if isinstance(value, str) else None

    @field_validator("clientType", "clientName", mode="before")
    @classmethod
    def compatible_client(cls, value: object) -> str:
        return value if isinstance(value, str) else "Browser"


class UserCreateInput(InputModel):
    """新账号的密码只能在创建阶段提供，后续管理员使用恢复流程。"""

    username: str = ""
    email: str | None = Field(default=None, max_length=254)
    displayName: str | None = None
    password: str | None = Field(default=None, max_length=1024)
    passwordVerifier: str | None = Field(default=None, max_length=100)
    passwordSalt: str | None = Field(default=None, max_length=128)
    roles: list[str] = Field(default_factory=lambda: ["member"], max_length=30)
    role: str | None = Field(default=None, max_length=100)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: object) -> str:
        """沿用旧text规则；省略用户名时由创建用例在事务内按邮箱推导。"""
        return value.strip().lower() if isinstance(value, str) else ""

    @model_validator(mode="after")
    def resolve_legacy_role(self) -> Self:
        """保留现有客户端单角色字段；显式 roles 的优先级保持不变。"""
        if "roles" not in self.model_fields_set and self.role:
            self.roles = [self.role]
        self.roles = sorted(set(self.roles))
        return self

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        """空邮箱存 NULL；非空地址规范化，避免空串唯一索引冲突和大小写重复。"""
        normalized = value.strip().lower() if value else ""
        return email_address(normalized) if normalized else None


class RegisterInput(UserCreateInput):
    """首个管理员初始化 DTO，角色由用例固定而非客户端控制。"""

    setupToken: str = Field(default="", max_length=200)
    code: str = Field(default="", max_length=20)
    clientType: str = "browser"
    clientName: str = Field(default="Browser", max_length=200)


class UserPatchInput(InputModel):
    """revision 用于拒绝并发覆盖；角色和状态均经过应用层复验。"""

    displayName: str | None = None
    roles: list[str] | None = Field(default=None, max_length=30)
    disabled: bool | None = None
    revision: int | None = Field(default=None, ge=1)
    role: str | None = Field(default=None, max_length=100)

    @model_validator(mode="before")
    @classmethod
    def reject_password_write(cls, value: object) -> object:
        """旧管理契约以409拒绝任何他人密码字段，不让DTO提前改为通用422。"""
        if isinstance(value, dict) and any(
            key in value for key in ("password", "passwordVerifier", "passwordSalt")
        ):
            from app.infrastructure.errors import DomainError

            raise DomainError(
                409,
                "administrators cannot set another account's password; request recovery instead",
            )
        return value

    @model_validator(mode="after")
    def resolve_legacy_role(self) -> Self:
        """旧单角色更新和新角色列表进入同一个权限用例，不新增版本路由。"""
        if "roles" not in self.model_fields_set and self.role is not None:
            self.roles = [self.role]
        if self.roles is not None:
            self.roles = sorted(set(self.roles))
        return self


class RoleInput(InputModel):
    """角色名称、权限与并发版本。"""

    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    permissions: list[str] = Field(max_length=100)
    revision: int | None = Field(default=None, ge=1)

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, value: object) -> object:
        """先去首尾空白再检查长度，与现有角色编辑协议一致。"""
        return value.strip() if isinstance(value, str) else value


class RefreshInput(InputModel):
    """原生端显式令牌；浏览器只发送 HttpOnly Cookie。"""

    refreshToken: str | None = Field(default=None, max_length=512)
    # 桌面和安卓会随刷新发送展示名称；旧端接受但不修改已建立会话的名称。
    clientName: str | None = None


class PasswordInput(InputModel):
    """本人改密支持客户端挑战格式。"""

    newPassword: str | None = Field(default=None, max_length=1024)
    newPasswordVerifier: str | None = Field(default=None, max_length=100)
    newPasswordSalt: str | None = Field(default=None, max_length=128)


def account_payload(account: Account) -> dict[str, object]:
    """只暴露公开账号字段，保持旧客户端 camelCase 表达。"""
    return {
        "userId": account.user_id,
        "username": account.username,
        "email": account.email,
        "emailVerified": account.email_verified_at is not None,
        "avatarUrl": account.avatar_url,
        "avatar": account.avatar_url,
        "createdAt": account.created_at.isoformat() if account.created_at else None,
        "updatedAt": account.updated_at.isoformat() if account.updated_at else None,
        "displayName": account.display_name,
        "role": "admin" if "admin" in account.roles else "member",
        "roles": list(account.roles),
        "permissions": list(account.permissions),
        "authzVersion": account.auth_version,
        "resetRequired": account.reset_required,
        "disabled": account.disabled,
        "deletedAt": account.deleted_at.isoformat() if account.deleted_at else None,
        "revision": account.revision,
        "serverTime": datetime.now(UTC).isoformat(),
    }


def role_payload(role: Role) -> dict[str, object]:
    """角色公开 DTO 不暴露数据库内部表达。"""
    return {
        "id": role.id,
        "name": role.name,
        "description": role.description,
        "permissions": role.permissions,
        "builtin": role.builtin,
        "revision": role.revision,
    }

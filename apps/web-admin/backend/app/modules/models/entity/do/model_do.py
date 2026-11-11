"""模型供应商、能力配置、不可变修订及默认选择的持久映射。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class ModelProviderRow(Base):
    """个人与平台供应商共用协议，凭据只能以绑定资源身份的密文保存。"""

    __tablename__ = "model_providers"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    protocol: Mapped[str] = mapped_column(String(50))
    base_url: Mapped[str] = mapped_column(Text)
    models: Mapped[list[dict[str, object]]] = mapped_column(JSONB)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    credential: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ModelDefaultRow(Base):
    """个人默认选择优先于平台，删除供应商时在同一事务移除。"""

    __tablename__ = "model_defaults"
    scope: Mapped[str] = mapped_column(String(100), primary_key=True)
    provider_id: Mapped[str] = mapped_column(ForeignKey("model_providers.id"))
    model_id: Mapped[str] = mapped_column(String(200))


class ModelConnectionRow(Base):
    """多模态与聊天共用连接，编辑不向客户端返回旧密钥。"""

    __tablename__ = "model_connections"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    adapter: Mapped[str] = mapped_column(String(50))
    base_url: Mapped[str] = mapped_column(Text)
    region: Mapped[str] = mapped_column(String(100), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    credential: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ModelConfigurationRow(Base):
    """能力配置当前状态决定授权，历史版本决定被冻结执行参数。"""

    __tablename__ = "model_configurations"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    connection_id: Mapped[str] = mapped_column(ForeignKey("model_connections.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    capability: Mapped[str] = mapped_column(String(50))
    model_id: Mapped[str] = mapped_column(String(200))
    revision: Mapped[int] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean)
    parameters: Mapped[dict[str, object]] = mapped_column(JSONB)
    role_ids: Mapped[list[str]] = mapped_column(JSONB)


class ModelConfigurationVersionRow(Base):
    """只追加的配置快照，不包含供应商密钥。"""

    __tablename__ = "model_configuration_versions"
    configuration_id: Mapped[str] = mapped_column(
        ForeignKey("model_configurations.id"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    definition: Mapped[dict[str, object]] = mapped_column(JSONB)


class ModelCapabilityDefaultRow(Base):
    """能力默认值使用独立修订，避免两个管理员互相覆盖。"""

    __tablename__ = "model_capability_defaults"
    capability: Mapped[str] = mapped_column(String(50), primary_key=True)
    configuration_id: Mapped[str | None] = mapped_column(ForeignKey("model_configurations.id"))
    revision: Mapped[int] = mapped_column(Integer, default=0)


class ModelOperationRow(Base):
    """收费能力操作持久收据，由操作标识幂等提交和核对。"""

    __tablename__ = "model_operations"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(200))
    configuration_id: Mapped[str] = mapped_column(String(100))
    configuration_revision: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(30))
    request_id: Mapped[str | None] = mapped_column(String(200))
    usage: Mapped[dict[str, object]] = mapped_column(JSONB, default=dict)
    result: Mapped[dict[str, object]] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    receipt_ciphertext: Mapped[str | None] = mapped_column(Text)
    lease_token: Mapped[str | None] = mapped_column(String(64))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

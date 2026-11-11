"""后端启动模型配置契约；声明式默认配置与交互式修订比较分开。"""

from typing import Self

from pydantic import Field, model_validator

from app.modules.models.entity.vo.model_vo import (
    Capability,
    ConfigurationInput,
    ConnectionInput,
    ModelInput,
)


class StartupConnection(ConnectionInput):
    """稳定连接标识保留数据库引用；密钥沿用省略保留、显式清空语义。"""

    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")


class StartupConfiguration(ConfigurationInput):
    """稳定能力配置标识允许启动时幂等同步并追加必要修订。"""

    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")


class StartupModels(ModelInput):
    """仅管理文件中明确声明的记录，缺省 defaults 不改变已有选择。"""

    connections: list[StartupConnection] = Field(default_factory=list, max_length=100)
    configurations: list[StartupConfiguration] = Field(default_factory=list, max_length=1000)
    defaults: dict[Capability, str | None] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_references(self) -> Self:
        """写入前检查完整引用图，拒绝重复标识、无效默认值和交互式 revision。"""
        connections = {item.id: item for item in self.connections}
        configurations = {item.id: item for item in self.configurations}
        if len(connections) != len(self.connections) or len(configurations) != len(
            self.configurations
        ):
            raise ValueError("启动模型配置标识重复")
        seen: set[tuple[str, str]] = set()
        if any(item.revision is not None for item in self.connections) or any(
            item.revision is not None for item in self.configurations
        ):
            raise ValueError("启动配置不填写交互式 revision")
        for item in self.configurations:
            if item.connectionId not in connections or len(set(item.roleIds)) != len(item.roleIds):
                raise ValueError("启动模型连接引用或角色列表无效")
            if item.capability == "chat":
                key = (item.connectionId, item.modelId)
                if key in seen:
                    raise ValueError("同一连接不能重复声明聊天模型")
                seen.add(key)
        for capability, identifier in self.defaults.items():
            if identifier is None:
                continue
            selected = configurations.get(identifier)
            if (
                selected is None
                or selected.capability != capability
                or not selected.enabled
                or not connections[selected.connectionId].enabled
            ):
                raise ValueError("默认模型必须引用同能力且已启用的配置和连接")
        return self

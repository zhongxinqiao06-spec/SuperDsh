"""在资源绑定边界冻结Schema声明的模型能力，不按工具场景名称判断。"""

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.models.service.configuration_service import ConfigurationService


class ToolModelBindingService:
    """工具配置Schema的能力注解是唯一来源，默认配置只在新绑定时读取。"""

    def __init__(self, configurations: ConfigurationService) -> None:
        self.configurations = configurations

    async def freeze(self, account: Account, snapshot: dict[str, object]) -> dict[str, object]:
        """返回不含密钥的配置ID/修订；执行时另行检查最新授权与冻结参数。"""
        schema = snapshot.get("configurationSchema")
        properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
        declarations = (
            {
                str(key): str(value["x-superdsh-capability"])
                for key, value in properties.items()
                if isinstance(value, dict) and value.get("x-superdsh-capability")
            }
            if isinstance(properties, dict)
            else {}
        )
        if not declarations:
            return snapshot
        catalog = await self.configurations.catalog(account)
        configurations, defaults = catalog["configurations"], catalog["defaults"]
        assert isinstance(configurations, list) and isinstance(defaults, list)
        settings = snapshot.get("settings", {})
        assert isinstance(settings, dict)
        bindings: dict[str, object] = {}
        for field, capability in declarations.items():
            selected = settings.get(field) or next(
                (
                    item.get("configurationId")
                    for item in defaults
                    if isinstance(item, dict) and item.get("capability") == capability
                ),
                None,
            )
            configuration = next(
                (
                    item
                    for item in configurations
                    if isinstance(item, dict)
                    and item.get("id") == selected
                    and item.get("capability") == capability
                ),
                None,
            )
            if not isinstance(configuration, dict):
                raise DomainError(409, "工具需要的模型能力尚未配置或当前角色不可用")
            binding = CapabilityBinding.model_validate(
                {
                    "configurationId": configuration["id"],
                    "revision": configuration["revision"],
                    "capability": capability,
                }
            )
            await self.configurations.resolve(account, binding)
            bindings[field] = binding.model_dump()
        return {**snapshot, "capabilityBindings": bindings}

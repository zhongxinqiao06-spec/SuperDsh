"""默认权限以当前 Host 的公开配置为准，执行标识只采用引擎目录返回值。"""

from app.integrations.dsh.bridge import RuntimeBridge
from app.integrations.dsh.process import HarnessProcess
from app.integrations.dsh.protocol import Fields, Json, RuntimeFailure, fields


class PermissionSelectionService:
    """目录展示与首次提交使用同一默认解析，不升级权限或覆盖显式选择。"""

    async def catalog(self, bridge: RuntimeBridge, process: HarnessProcess) -> Fields:
        """读取引擎实际默认权限并标注目录；缺失默认时保留其他显式选项。"""
        catalog = fields(await bridge.request("catalog.listPermissions", {}))
        defaults = await process.runtime_defaults()
        default = defaults.get("permissionPreset")
        values = catalog.get("permissions")
        if not isinstance(default, str) or not default or not isinstance(values, list):
            raise RuntimeFailure("permission_default_invalid", "引擎默认权限配置无效", 409)
        items: list[Json] = []
        for raw in values:
            entry = fields(raw)
            items.append(
                {
                    **entry,
                    "default": entry.get("enabled") is True
                    and fields(entry.get("metadata") or {}).get("preset") == default,
                }
            )
        return {**catalog, "permissions": items}

    async def apply_default(
        self, params: Fields, bridge: RuntimeBridge, process: HarnessProcess
    ) -> Fields:
        """仅首次创建未选权限时补齐；无法确认默认值则在发送前拒绝。"""
        raw = params.get("selections")
        selections = {} if raw is None else fields(raw)
        if selections.get("permission") is not None:
            return params
        catalog = await self.catalog(bridge, process)
        permissions = catalog["permissions"]
        assert isinstance(permissions, list)
        for raw_entry in permissions:
            entry = fields(raw_entry)
            identifier = entry.get("selectionId")
            if entry.get("default") is True and isinstance(identifier, str) and identifier:
                return {**params, "selections": {**selections, "permission": identifier}}
        raise RuntimeFailure(
            "permission_default_unavailable", "引擎默认权限未在目录中启用，请检查引擎配置", 409
        )

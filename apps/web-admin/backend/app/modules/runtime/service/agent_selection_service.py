"""新建通用会话采用固定 DSH 目录声明的默认运行模式，不绑定业务智能体。"""

from app.integrations.dsh.bridge import RuntimeBridge
from app.integrations.dsh.protocol import Fields, RuntimeFailure, fields


class AgentSelectionService:
    """仅补齐首次创建缺省模式，冻结的业务预设和已有会话仍保持原选择。"""

    async def apply_default(self, params: Fields, bridge: RuntimeBridge) -> Fields:
        """模式来自引擎目录，校验可用后才交给监督器占用执行收据。"""
        if params.get("agentPreset") is not None:
            return params
        catalog = fields(await bridge.request("catalog.listAgentPresets", {}))
        default = fields(catalog.get("configField") or {}).get("default")
        if not isinstance(default, str) or not default or len(default) > 256:
            raise RuntimeFailure(
                "agent_default_invalid", "服务端 Agent 未提供默认运行模式，请检查引擎配置", 409
            )
        presets = catalog.get("presets")
        if isinstance(presets, list):
            for raw in presets:
                preset = fields(raw)
                if preset.get("id") == default and preset.get("enabled") is True:
                    return {**params, "agentPreset": default}
        raise RuntimeFailure(
            "agent_default_unavailable", "服务端 Agent 默认运行模式不可用，请检查引擎配置", 409
        )

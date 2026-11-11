"""将当前账号可用的默认模型映射到固定 DSH 目录中的真实选择标识。"""

from __future__ import annotations

import re

from app.integrations.dsh.bridge import RuntimeBridge
from app.integrations.dsh.protocol import Fields, Json, RuntimeFailure, fields
from app.modules.runtime.service.model_catalog_service import authorized_model_entries
from app.modules.runtime.service.ports import ModelProvider


class ModelSelectionService:
    """统一目录展示和提交校验，缺省时补齐默认值，显式选择不自动换供应商。"""

    def __init__(self, models: ModelProvider) -> None:
        self.models = models

    @staticmethod
    def target(catalog: Fields) -> tuple[str, str] | None:
        """把已授权默认配置映射为供应商和模型身份，不选择目录首项。"""
        default = catalog.get("default")
        if default is None:
            return None
        default = fields(default)
        scope, provider, model = (
            catalog.get("scope"),
            default.get("providerId"),
            default.get("modelId"),
        )
        if (
            not isinstance(scope, str)
            or re.fullmatch(r"[a-f0-9]{64}", scope) is None
            or not isinstance(provider, str)
            or not provider
            or not isinstance(model, str)
            or not model
        ):
            raise RuntimeFailure("model_default_invalid", "默认模型配置无效，请检查模型设置", 409)
        return f"superdsh-{scope}-{provider}", model

    async def annotate(self, owner: str, catalog: Fields) -> Fields:
        """仅展示该账号配置的连接，标明默认值及来源，不把内置条目当作已配密钥。"""
        configuration = await self.models.catalog(owner)
        target = self.target(configuration)
        values = catalog.get("models")
        if not isinstance(values, list):
            raise RuntimeFailure("invalid_runtime_frame", "运行时模型目录无效", 502)
        models: list[Json] = []
        for entry in authorized_model_entries(configuration, [fields(raw) for raw in values]):
            metadata = fields(entry.get("metadata") or {})
            models.append(
                {
                    **entry,
                    "default": bool(target)
                    and entry.get("enabled") is True
                    and not metadata.get("reasoningEffort")
                    and (metadata.get("provider"), metadata.get("model")) == target,
                }
            )
        return {**catalog, "models": models}

    async def validate_explicit(self, owner: str, params: Fields, bridge: RuntimeBridge) -> None:
        """拒绝旧草稿、已撤销或其他账号的模型标识，推理变体同样必须属于授权模型。"""
        selections = fields(params.get("selections") or {})
        identifier = selections.get("model")
        if identifier is None:
            return
        runtime = fields(await bridge.request("catalog.listModels", {}))
        catalog = await self.annotate(owner, runtime)
        values = catalog.get("models")
        assert isinstance(values, list)
        for raw in values:
            entry = fields(raw)
            if entry.get("enabled") is not True:
                continue
            if identifier and entry.get("selectionId") == identifier:
                return
            reasoning = entry.get("reasoningItems")
            for value in reasoning if isinstance(reasoning, list) else []:
                item = fields(value)
                if (
                    identifier
                    and item.get("enabled") is True
                    and item.get("selectionId") == identifier
                ):
                    return
        raise RuntimeFailure(
            "model_selection_unavailable",
            "所选模型未配置或已停用，请在下方重新选择可用模型后发送",
            409,
        )

    async def apply_default(self, owner: str, params: Fields, bridge: RuntimeBridge) -> Fields:
        """按已授权目录的个人／平台默认值选择；同步未完成时明确失败，禁止换供应商。"""
        raw_selections = params.get("selections")
        selections = {} if raw_selections is None else fields(raw_selections)
        if selections.get("model") is not None:
            await self.validate_explicit(owner, params, bridge)
            return params
        configuration = await self.models.catalog(owner)
        target = self.target(configuration)
        if target is None:
            raise RuntimeFailure(
                "model_default_invalid", "尚未配置默认聊天模型，请检查模型设置", 409
            )
        runtime = fields(await bridge.request("catalog.listModels", {}))
        models = runtime.get("models")
        if isinstance(models, list):
            for entry in authorized_model_entries(configuration, [fields(raw) for raw in models]):
                metadata = fields(entry.get("metadata") or {})
                # provider 命名属于固定 managed-models 适配契约；selectionId 保持不透明，
                # 必须采用引擎返回值，不能在平台复制其编码或推理参数规则。
                if (metadata.get("provider"), metadata.get("model")) != target or metadata.get(
                    "reasoningEffort"
                ):
                    continue
                identifier = entry.get("selectionId")
                if entry.get("enabled") is True and isinstance(identifier, str) and identifier:
                    return {**params, "selections": {**selections, "model": identifier}}
        raise RuntimeFailure(
            "model_default_unavailable", "默认模型尚未在运行时就绪，请刷新模型目录后重试", 409
        )

"""将账号授权的模型配置与 DSH 实际目录求交集，不暴露未配置的引擎内置连接。"""

import re

from app.integrations.dsh.protocol import Fields, fields


def authorized_model_entries(configuration: Fields, entries: list[Fields]) -> list[Fields]:
    """身份按账号、供应商和模型匹配；同名的个人与平台连接保留，选择标识仍由引擎提供。"""
    scope = configuration.get("scope")
    if not isinstance(scope, str) or re.fullmatch(r"[a-f0-9]{64}", scope) is None:
        return []
    configured: dict[tuple[str, str], tuple[Fields, Fields]] = {}
    providers = configuration.get("providers")
    for raw in providers if isinstance(providers, list) else []:
        provider = fields(raw)
        identifier, models = provider.get("providerId"), provider.get("models")
        if not isinstance(identifier, str) or not identifier:
            continue
        for value in models if isinstance(models, list) else []:
            model = fields(value)
            model_id = model.get("modelId")
            if isinstance(model_id, str) and model_id:
                configured[(f"superdsh-{scope}-{identifier}", model_id)] = (provider, model)
    result = []
    for entry in entries:
        metadata = fields(entry.get("metadata") or {})
        match = configured.get((str(metadata.get("provider")), str(metadata.get("model"))))
        if match is None:
            continue
        provider, model = match
        name = model.get("name") or model.get("modelId")
        # 引擎会因内置同名模型添加供应商后缀；展示由配置名和独立来源字段组成。
        # 显式推理变体的后缀仍保留，不能把不同的引擎选择身份按名称合并。
        original, title = metadata.get("modelName"), entry.get("title")
        suffix = (
            title[len(original) :]
            if isinstance(original, str)
            and isinstance(title, str)
            and title.startswith(original + " · ")
            else ""
        )
        result.append(
            {
                **entry,
                "title": f"{name}{suffix}",
                "metadata": {
                    **metadata,
                    "modelName": name,
                    "providerName": provider.get("name"),
                    "source": provider.get("source"),
                },
            }
        )
    return result

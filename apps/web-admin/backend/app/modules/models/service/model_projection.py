"""聊天供应商与统一能力配置的双向投影，在同一领域事务内保持目录一致。"""

import hashlib
from datetime import UTC, datetime

from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import (
    ModelConfigurationRow,
    ModelConfigurationVersionRow,
    ModelConnectionRow,
    ModelProviderRow,
)


def snapshot(row: ModelConfigurationRow) -> dict[str, object]:
    """冻结能力参数不包含密钥，角色范围随修订保留。"""
    return {
        "id": row.id,
        "name": row.name,
        "kind": "chat" if row.capability == "chat" else "multimodal",
        "connectionId": row.connection_id,
        "capability": row.capability,
        "modelId": row.model_id,
        "revision": row.revision,
        "enabled": row.enabled,
        "parameters": row.parameters,
        "roleIds": row.role_ids,
    }


async def synchronize_provider(dao: ModelDao, provider: ModelProviderRow) -> None:
    """旧供应商接口编辑后，统一连接与新聊天配置立即可见。"""
    if provider.owner_id is not None:
        return
    connection = await dao.connection(provider.id)
    if connection is None:
        connection = ModelConnectionRow(
            id=provider.id, created_at=provider.created_at, revision=0, region=""
        )
        dao.add(connection)
    connection.name, connection.base_url = provider.name, provider.base_url
    connection.adapter = (
        "volcengine-ark" if connection.adapter == "volcengine-ark" else provider.protocol
    )
    connection.credential, connection.enabled, connection.updated_at = (
        provider.credential,
        provider.enabled,
        provider.updated_at,
    )
    connection.revision += 1
    await dao.session.flush()
    configurations = await dao.configurations(provider.id)
    for model in provider.models:
        if any(
            row.capability == "chat" and row.model_id == model["modelId"] for row in configurations
        ):
            continue
        identifier = (
            "chat_"
            + hashlib.sha256((provider.id + "\0" + str(model["modelId"])).encode()).hexdigest()[:32]
        )
        parameters = {"maxTokens": model.get("maxTokens") or 4096}
        if model.get("contextWindow"):
            parameters["contextWindow"] = model["contextWindow"]
        row = ModelConfigurationRow(
            id=identifier,
            connection_id=provider.id,
            name=str(model["name"]),
            capability="chat",
            model_id=str(model["modelId"]),
            revision=1,
            enabled=True,
            parameters=parameters,
            role_ids=[],
        )
        dao.add(row)
        await dao.session.flush()
        dao.add(
            ModelConfigurationVersionRow(
                configuration_id=identifier, revision=1, definition=snapshot(row)
            )
        )
    included = {item["modelId"] for item in provider.models}
    for row in configurations:
        if row.capability == "chat" and row.model_id not in included and row.enabled:
            row.enabled, row.revision = False, row.revision + 1
            dao.add(
                ModelConfigurationVersionRow(
                    configuration_id=row.id, revision=row.revision, definition=snapshot(row)
                )
            )


async def project_connection(dao: ModelDao, connection: ModelConnectionRow) -> None:
    """新管理表单编辑聊天配置后，DSH 原有供应商目录仍可读取。"""
    configs = [row for row in await dao.configurations(connection.id) if row.capability == "chat"]
    if not configs:
        return
    provider = await dao.provider(connection.id)
    now = datetime.now(UTC)
    if provider is None:
        provider = ModelProviderRow(id=connection.id, owner_id=None, created_at=now, models=[])
        dao.add(provider)
    old_models = {str(item["modelId"]): item for item in provider.models}
    provider.name, provider.protocol, provider.base_url = (
        connection.name,
        "openai-responses" if connection.adapter == "volcengine-ark" else connection.adapter,
        connection.base_url,
    )
    provider.credential, provider.enabled, provider.updated_at = (
        connection.credential,
        connection.enabled,
        now,
    )
    provider.models = [
        {
            "modelId": row.model_id,
            "name": row.name,
            "contextWindow": row.parameters.get(
                "contextWindow", old_models.get(row.model_id, {}).get("contextWindow")
            ),
            "maxTokens": row.parameters.get("maxTokens", 4096),
            "inputTypes": old_models.get(row.model_id, {}).get("inputTypes", ["text", "image"]),
        }
        for row in configs
        if row.enabled
    ]

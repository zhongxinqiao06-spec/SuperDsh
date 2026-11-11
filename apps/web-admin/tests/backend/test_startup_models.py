"""正式启动模型配置的实库幂等、事务、重启与来源隔离验证。"""

import asyncio
import json
from pathlib import Path

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.infrastructure.configuration import Settings
from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.errors import DomainError
from app.main import create_app
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.vo.startup_vo import StartupModels
from app.modules.models.service.startup_service import StartupModelService
from app.modules.models.service.tool_binding_service import ToolModelBindingService


def configuration() -> StartupModels:
    """合成模型仅用于配置同步，不发出外部请求。"""
    return StartupModels.model_validate(
        {
            "connections": [
                {
                    "id": "startup-provider",
                    "name": "启动连接",
                    "adapter": "openai-completions",
                    "baseUrl": "https://model.synthetic.invalid",
                    "apiKey": "synthetic-secret",
                }
            ],
            "configurations": [
                {
                    "id": "startup-chat",
                    "name": "启动聊天",
                    "connectionId": "startup-provider",
                    "capability": "chat",
                    "modelId": "synthetic-chat",
                    "parameters": {"maxTokens": 512},
                },
                {
                    "id": "startup-other",
                    "name": "另一个聊天",
                    "connectionId": "startup-provider",
                    "capability": "chat",
                    "modelId": "synthetic-other",
                    "parameters": {"maxTokens": 256},
                },
            ],
            "defaults": {"chat": "startup-chat"},
        }
    )


def service(application: FastAPI) -> StartupModelService:
    """复用实际数据库及公开身份端口，不构造绕过认证的假管理员。"""
    return StartupModelService(
        application.state.database,
        CredentialCipher(application.state.settings.encryption_key.get_secret_value()),
        application.state.services.identity.role_exists,
    )


def write_configuration(path: Path, body: StartupModels) -> None:
    """只有此合成测试导出明文凭据；生产序列化不能依赖 SecretStr 默认脱敏。"""
    document = body.model_dump(mode="json", exclude={"connections"})
    document["connections"] = [
        {
            **item.model_dump(mode="json", exclude={"apiKey"}),
            "apiKey": item.apiKey.get_secret_value() if item.apiKey else None,
        }
        for item in body.connections
    ]
    path.write_text(json.dumps(document), encoding="utf-8")


async def test_actual_lifespan_reads_file_restarts_and_updates_default(
    platform_configuration: Settings, tmp_path: Path
) -> None:
    path = tmp_path / "model-defaults.json"
    body = configuration()
    write_configuration(path, body)
    settings = platform_configuration.model_copy(update={"model_defaults_file": path})
    for attempt in range(3):
        if attempt == 2:
            body.connections[0].name = "配置文件新名称"
            body.configurations[0].name = "新聊天名称"
            body.defaults["chat"] = "startup-other"
            write_configuration(path, body)
        application = create_app(settings)
        async with application.router.lifespan_context(application):
            async with application.state.database.sessions() as session:
                dao = ModelDao(session)
                row = await dao.connection("startup-provider")
                selected = await dao.default("global")
                config = await dao.configuration("startup-chat")
                assert row and config and selected
                assert row.revision == (2 if attempt == 2 else 1)
                assert config.revision == (2 if attempt == 2 else 1)
                assert selected.model_id == (
                    "synthetic-other" if attempt == 2 else "synthetic-chat"
                )
                assert row.credential and "synthetic-secret" not in row.credential
                assert await dao.configuration_version(config.id, 1) is not None
            if attempt == 0:
                async with AsyncClient(
                    transport=ASGITransport(application),
                    base_url="http://localhost:5175",
                    headers={"Origin": "http://localhost:5175"},
                ) as client:
                    await bootstrap(client)
                    response = await client.get("/api/models/catalog")
                    assert response.status_code == 200
                    assert response.json()["default"]["modelId"] == "synthetic-chat"
                    assert "synthetic-secret" not in response.text


async def test_multimodal_startup_defaults_reach_catalog_and_tool_bindings_after_restart(
    platform_configuration: Settings, tmp_path: Path
) -> None:
    """同一火山连接承载聊天、视觉和生图；重启不重复创建，工具按能力冻结默认。"""
    document = configuration().model_dump(mode="json")
    document["connections"][0].update(adapter="volcengine-ark", apiKey="synthetic-secret")
    document["configurations"].extend(
        [
            {
                "id": "startup-vision",
                "name": "合成视觉",
                "connectionId": "startup-provider",
                "capability": "vision.analyze",
                "modelId": "synthetic-vision",
                "parameters": {"maxTokens": 4096, "maxImages": 4, "thinking": "disabled"},
            },
            {
                "id": "startup-image",
                "name": "合成生图",
                "connectionId": "startup-provider",
                "capability": "image.generate",
                "modelId": "synthetic-image",
                "parameters": {"imageProfile": "seedream-5", "size": "2K", "maxImages": 4},
            },
        ]
    )
    document["defaults"].update(
        {"vision.analyze": "startup-vision", "image.generate": "startup-image"}
    )
    path = tmp_path / "multimodal-defaults.json"
    write_configuration(path, StartupModels.model_validate(document))
    settings = platform_configuration.model_copy(update={"model_defaults_file": path})
    token = ""
    for attempt in range(2):
        application = create_app(settings)
        async with (
            application.router.lifespan_context(application),
            AsyncClient(
                transport=ASGITransport(application),
                base_url="http://localhost:5175",
                headers={"Origin": "http://localhost:5175"},
            ) as client,
        ):
            if attempt == 0:
                token = str((await bootstrap(client))["accessToken"])
            client.headers["Authorization"] = "Bearer " + token
            response = await client.get("/api/admin/models/configurations")
            assert response.status_code == 200
            catalog = response.json()
            assert "synthetic-secret" not in response.text
            assert len(catalog["connections"]) == 1
            assert catalog["connections"][0]["credentialConfigured"] is True
            assert {
                row["capability"]
                for row in catalog["configurations"]
                if row["kind"] == "multimodal"
            } == {"vision.analyze", "image.generate"}
            assert all(row["revision"] == 1 for row in catalog["configurations"])
            assert {
                row["capability"]: row["configurationId"] for row in catalog["defaults"]
            } == document["defaults"]
            chat = await client.get("/api/models/catalog")
            assert chat.json()["default"]["modelId"] == "synthetic-chat"
            account = await application.state.services.identity.authenticate(token)
            tool = ToolModelBindingService(application.state.services.model_configurations)
            frozen = await tool.freeze(
                account,
                {
                    "settings": {},
                    "configurationSchema": {
                        "properties": {
                            "visionModel": {"x-superdsh-capability": "vision.analyze"},
                            "imageModel": {"x-superdsh-capability": "image.generate"},
                        }
                    },
                },
            )
            assert frozen["capabilityBindings"] == {
                "visionModel": {
                    "capability": "vision.analyze",
                    "configurationId": "startup-vision",
                    "revision": 1,
                },
                "imageModel": {
                    "capability": "image.generate",
                    "configurationId": "startup-image",
                    "revision": 1,
                },
            }


async def test_concurrent_sync_preserves_revision_history_and_unlisted_models(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    login = await bootstrap(client)
    account = await application.state.services.identity.authenticate(str(login["accessToken"]))
    personal = await client.post(
        "/api/models/personal/providers",
        json={
            "name": "个人自定义",
            "protocol": "openai-completions",
            "baseUrl": "https://personal.synthetic.invalid",
            "apiKey": "synthetic-personal-key",
            "models": [{"name": "个人", "modelId": "personal-model"}],
        },
    )
    assert personal.status_code == 200
    await asyncio.gather(*(service(application).synchronize(configuration()) for _ in range(4)))
    async with application.state.database.sessions() as session:
        dao = ModelDao(session)
        row = await dao.connection("startup-provider")
        assert row and row.revision == 1
        assert len(await dao.configurations("startup-provider")) == 2
        assert await dao.configuration_version("startup-chat", 2) is None
        assert (await dao.providers(account.user_id))[0].name == "个人自定义"
    empty = StartupModels()
    await service(application).synchronize(empty)
    async with application.state.database.sessions() as session:
        assert await ModelDao(session).default("global") is not None
    await service(application).synchronize(StartupModels(defaults={"chat": None}))
    async with application.state.database.sessions() as session:
        assert await ModelDao(session).default("global") is None
        assert len(await ModelDao(session).connections()) == 1


async def test_invalid_parameters_roll_back_whole_file(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, _ = platform
    body = configuration()
    body.configurations[1].parameters = {"maxTokens": -1}
    with pytest.raises(DomainError):
        await service(application).synchronize(body)
    async with application.state.database.sessions() as session:
        dao = ModelDao(session)
        assert await dao.connections() == []
        assert await dao.configurations() == []
        assert await dao.providers(None) == []
        assert await dao.default("global") is None


async def test_unsafe_rebind_rejected_and_key_rotation_is_idempotent(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, _ = platform
    body = configuration()
    await service(application).synchronize(body)
    changed = body.model_copy(deep=True)
    changed.connections[0].baseUrl = "https://changed.synthetic.invalid"
    with pytest.raises(RuntimeError, match="不能更改"):
        await service(application).synchronize(changed)
    from pydantic import SecretStr

    body.connections[0].apiKey = SecretStr("synthetic-rotated-key")
    await service(application).synchronize(body)
    await service(application).synchronize(body)
    async with application.state.database.sessions() as session:
        row = await ModelDao(session).connection("startup-provider")
        assert row and row.revision == 2 and row.base_url == "https://model.synthetic.invalid"
        assert (
            row.credential
            and service(application).cipher.open(row.credential, row.id) == "synthetic-rotated-key"
        )
        config = await ModelDao(session).configuration("startup-chat")
        assert config and config.revision == 1


async def test_invalid_file_fails_startup_and_releases_runtime(
    platform_configuration: Settings, tmp_path: Path
) -> None:
    path = tmp_path / "model-defaults.json"
    path.write_text('{"apiKey":"synthetic-secret"', encoding="utf-8")
    settings = platform_configuration.model_copy(update={"model_defaults_file": path})
    invalid = create_app(settings)
    with pytest.raises(RuntimeError, match="配置无效"):
        async with invalid.router.lifespan_context(invalid):
            pytest.fail("非法配置不能启动服务")
    write_configuration(path, configuration())
    recovered = create_app(settings)
    async with recovered.router.lifespan_context(recovered):
        async with recovered.state.database.sessions() as session:
            assert await ModelDao(session).default("global") is not None

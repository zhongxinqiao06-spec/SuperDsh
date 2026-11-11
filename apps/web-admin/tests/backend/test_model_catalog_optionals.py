"""模型目录的可选字段兼容固定 DSH：未配置必须缺省，不能传 null。"""

from __future__ import annotations

import copy
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.crypto import CredentialCipher
from app.infrastructure.database import Database
from app.modules.identity.entity.bo.models import Account
from app.modules.models.dao.model_dao import ModelDao
from app.modules.models.entity.do.model_do import ModelDefaultRow, ModelProviderRow
from app.modules.models.entity.vo.model_vo import ProviderInput
from app.modules.models.service import model_service
from app.modules.models.service.model_service import ModelService


def service_fixture(monkeypatch: pytest.MonkeyPatch) -> tuple[ModelService, AsyncMock]:
    """仅注入持久化边界，无数据库、网络、真实凭据或运行进程。"""
    database = Mock(spec=Database)
    session = AsyncMock()
    session.__aenter__.return_value = session
    session.begin = Mock(return_value=AsyncMock())
    database.sessions = Mock(return_value=session)
    dao = AsyncMock(spec=ModelDao)
    monkeypatch.setattr(model_service, "ModelDao", lambda _: dao)
    monkeypatch.setattr(model_service, "lock_transaction", AsyncMock())
    monkeypatch.setattr(model_service, "synchronize_provider", AsyncMock())
    return ModelService(database, Mock(spec=CredentialCipher)), dao


@pytest.mark.parametrize("personal", [False, True])
async def test_catalog_omits_legacy_nulls_preserves_explicit_limits_and_defaults(
    monkeypatch: pytest.MonkeyPatch, personal: bool
) -> None:
    service, dao = service_fixture(monkeypatch)
    account = Account("synthetic-owner", "synthetic", ("member",), ("models.use",), 1)
    original_models: list[dict[str, object]] = [
        {
            "modelId": "unconfigured-limits",
            "name": "未填写上限",
            "maxTokens": None,
            "contextWindow": None,
            "inputTypes": ["text"],
        },
        {
            "modelId": "configured-limits",
            "name": "显式上限",
            "maxTokens": 768,
            "contextWindow": 24000,
            "inputTypes": ["text", "image"],
        },
    ]
    provider = ModelProviderRow(
        id="synthetic-provider",
        owner_id=account.user_id if personal else None,
        name="合成供应商",
        protocol="openai-completions",
        enabled=True,
        models=copy.deepcopy(original_models),
    )
    dao.providers.side_effect = lambda owner: [provider] if owner == provider.owner_id else []
    dao.configurations.return_value = []
    default = ModelDefaultRow(
        scope="user:" + account.user_id if personal else "global",
        provider_id=provider.id,
        model_id="unconfigured-limits",
    )
    dao.default.side_effect = lambda scope: default if scope == default.scope else None
    catalog = await service.catalog(account)
    assert catalog["providers"] == [
        {
            "providerId": provider.id,
            "name": provider.name,
            "protocol": provider.protocol,
            "source": "personal" if personal else "platform",
            "models": [
                {
                    "modelId": "unconfigured-limits",
                    "name": "未填写上限",
                    "inputTypes": ["text"],
                },
                original_models[1],
            ],
        }
    ]
    assert catalog["default"] == {
        "providerId": provider.id,
        "modelId": "unconfigured-limits",
    }
    assert provider.models == original_models


@pytest.mark.parametrize("explicit_null", [False, True])
async def test_new_provider_storage_does_not_materialize_unset_token_limits(
    monkeypatch: pytest.MonkeyPatch, explicit_null: bool
) -> None:
    service, dao = service_fixture(monkeypatch)
    dao.provider.return_value = None
    dao.selected_defaults.return_value = []
    definition: dict[str, object] = {"modelId": "synthetic-chat", "name": "合成聊天"}
    if explicit_null:
        definition.update({"maxTokens": None, "contextWindow": None})
    body = ProviderInput.model_validate(
        {
            "name": "合成供应商",
            "protocol": "openai-completions",
            "baseUrl": "https://models.example.test",
            "models": [definition],
        }
    )
    account = Account("synthetic-owner", "synthetic", ("admin",), ("models.manage",), 1)
    result = await service.save_provider(account, body)
    assert result["models"] == [
        {"modelId": "synthetic-chat", "name": "合成聊天", "inputTypes": ["text"]}
    ]
    saved = dao.add.call_args.args[0]
    assert isinstance(saved, ModelProviderRow)
    assert saved.models == result["models"]

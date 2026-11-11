"""服务端只展示授权连接；保留真实选择身份、推理和个人／平台同名来源。"""

import copy

import pytest

from app.integrations.dsh.protocol import Fields, fields
from app.modules.runtime.service.model_catalog_service import authorized_model_entries

SCOPE = "a" * 64


@pytest.mark.parametrize("suffix", ["", " · High"])
def test_configured_label_preserves_identity_and_reasoning(suffix: str) -> None:
    configuration: Fields = {
        "scope": SCOPE,
        "providers": [
            {
                "providerId": "configured",
                "name": "Supplier",
                "source": "platform",
                "models": [{"modelId": "chat", "name": "Model-V4.1-Flash"}],
            }
        ],
    }
    entry: Fields = {
        "id": "opaque-model",
        "title": "Model-V41-Flash" + suffix,
        "selectionId": "opaque-selection",
        "enabled": False,
        "reasoningItems": [{"id": "high", "title": "High"}],
        "metadata": {
            "provider": f"superdsh-{SCOPE}-configured",
            "model": "chat",
            "modelName": "Model-V41-Flash",
        },
    }
    before = copy.deepcopy(entry)
    actual = authorized_model_entries(configuration, [entry])[0]
    assert actual["title"] == "Model-V4.1-Flash" + suffix
    assert entry == before
    assert all(
        actual[key] == before[key] for key in ("id", "selectionId", "enabled", "reasoningItems")
    )


def test_native_foreign_and_revoked_entries_hidden_but_same_names_preserved() -> None:
    configuration: Fields = {
        "scope": SCOPE,
        "providers": [
            {
                "providerId": source,
                "name": "Supplier",
                "source": source,
                "models": [{"modelId": "chat", "name": "同名模型"}],
            }
            for source in ("personal", "platform")
        ],
    }
    entries: list[Fields] = [
        {
            "id": identifier,
            "title": "同名模型（引擎后缀）",
            "selectionId": identifier,
            "enabled": True,
            "metadata": {"provider": identifier, "model": "chat"},
        }
        for identifier in [
            "native",
            f"superdsh-{'b' * 64}-personal",
            f"superdsh-{SCOPE}-revoked",
            f"superdsh-{SCOPE}-personal",
            f"superdsh-{SCOPE}-platform",
        ]
    ]
    actual = authorized_model_entries(configuration, entries)
    assert len(actual) == 2
    assert [item["title"] for item in actual] == ["同名模型", "同名模型"]
    assert actual[0]["selectionId"] != actual[1]["selectionId"]
    assert [fields(item["metadata"])["source"] for item in actual] == ["personal", "platform"]


@pytest.mark.parametrize("configuration", [{}, {"scope": "invalid"}, {"scope": SCOPE}])
def test_missing_authorized_catalog_does_not_expose_engine_defaults(configuration: Fields) -> None:
    assert authorized_model_entries(configuration, [{"title": "Native", "enabled": True}]) == []

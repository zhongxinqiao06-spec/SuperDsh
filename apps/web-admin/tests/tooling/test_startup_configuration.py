"""正式模型文件的严格校验与错误脱敏；仅使用外置临时目录和合成凭据。"""

import json
from pathlib import Path

import pytest

from app.modules.models.service.startup_configuration import load_startup_models


def payload() -> dict[str, object]:
    """通用合成配置不绑定真实供应商，所有参数都由文件提供。"""
    return {
        "connections": [
            {
                "id": "provider",
                "name": "合成",
                "adapter": "openai-completions",
                "baseUrl": "https://example.test",
                "apiKey": "synthetic-secret",
            }
        ],
        "configurations": [
            {
                "id": "chat",
                "name": "聊天",
                "connectionId": "provider",
                "capability": "chat",
                "modelId": "synthetic-chat",
            }
        ],
        "defaults": {"chat": "chat"},
    }


def test_valid_file_and_secret_repr(tmp_path: Path) -> None:
    path = tmp_path / "models.json"
    path.write_text(json.dumps(payload()), encoding="utf-8")
    configured = load_startup_models(path)
    assert configured.defaults == {"chat": "chat"}
    assert configured.connections[0].apiKey is not None
    assert configured.connections[0].apiKey.get_secret_value() == "synthetic-secret"
    assert "synthetic-secret" not in repr(configured)


@pytest.mark.parametrize(
    "change",
    [
        "unknown",
        "missing_connection",
        "missing_default",
        "wrong_capability",
        "disabled",
        "duplicate_connection",
        "duplicate_model",
        "revision",
        "credentials_in_url",
    ],
)
def test_invalid_configuration_fails_without_secret(tmp_path: Path, change: str) -> None:
    body = payload()
    # JSON 变换刻意使用真实边界输入，避免类型系统隐藏非法配置。
    if change == "unknown":
        body["unknown"] = "synthetic-secret"
    elif change == "missing_connection":
        body["connections"] = []
    elif change == "missing_default":
        body["defaults"] = {"chat": "missing"}
    elif change == "wrong_capability":
        body["defaults"] = {"vision.analyze": "chat"}
    else:
        raw = json.loads(json.dumps(body))
        if change == "disabled":
            raw["connections"][0]["enabled"] = False
        elif change == "duplicate_connection":
            raw["connections"].append(raw["connections"][0])
        elif change == "duplicate_model":
            raw["configurations"].append({**raw["configurations"][0], "id": "another"})
        elif change == "revision":
            raw["connections"][0]["revision"] = 3
        else:
            raw["connections"][0]["baseUrl"] = "https://user:synthetic-secret@example.test"
        body = raw
    path = tmp_path / "models.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(RuntimeError, match="启动配置无效") as error:
        load_startup_models(path)
    assert "synthetic-secret" not in str(error.value)
    assert error.value.__suppress_context__ is True


def test_missing_invalid_json_and_bounded_read(tmp_path: Path) -> None:
    path = tmp_path / "models.json"
    with pytest.raises(RuntimeError, match="无法读取"):
        load_startup_models(path)
    path.write_text('{"apiKey":"synthetic-secret"', encoding="utf-8")
    with pytest.raises(RuntimeError, match="配置无效") as error:
        load_startup_models(path)
    assert "synthetic-secret" not in str(error.value)
    path.write_bytes(b" " * (1024 * 1024 + 1))
    with pytest.raises(RuntimeError, match="1 MiB"):
        load_startup_models(path)

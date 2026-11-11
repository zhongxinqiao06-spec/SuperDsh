"""原生开发入口的配置边界测试，不启动数据库、迁移或服务监听。"""

import json
import os
import socket
import sys
from pathlib import Path

import pytest
from pydantic import SecretStr

import main as development
from app.infrastructure import development_migrations
from app.infrastructure.configuration import Settings
from main import configure_runtime_cache, load_development_environment


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """隔离开发配置与缓存，恢复入口修改的环境变量和解释器缓存设置。"""
    for key in tuple(os.environ):
        if key.startswith("WEB_ADMIN_"):
            monkeypatch.delenv(key)
    monkeypatch.setenv("WEB_ADMIN_CONFIG_ROOT", str(tmp_path))
    monkeypatch.setattr(development, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setenv("PYTHONPYCACHEPREFIX", str(tmp_path / ".superdsh-work/pycache"))
    monkeypatch.setattr(sys, "pycache_prefix", sys.pycache_prefix)
    # 入口用 setdefault 写入；先登记缺失键，确保每个用例结束时撤销这些变更。
    for key in ("WEB_ADMIN_BACKEND_PORT", "WEB_ADMIN_PUBLIC_ORIGIN"):
        monkeypatch.setenv(key, "")
        monkeypatch.delenv(key)


def write_config(root: Path, payload: object) -> None:
    """仅向 pytest 的独立临时目录写合成配置，不包含真实密钥。"""
    path = root / "config/backend-environment.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def configuration(environment: object) -> dict[str, object]:
    return {
        "owner": "superdsh-web-admin",
        "mode": "development",
        "environment": environment,
    }


def test_missing_initialization() -> None:
    with pytest.raises(RuntimeError, match="web-admin:init"):
        load_development_environment()


def test_models_default_to_backend_config_even_with_old_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """旧环境导出不能改变默认归属；任意 cwd 下均从后端自身 config 定位。"""
    write_config(
        tmp_path,
        configuration(
            {
                "WEB_ADMIN_BACKEND_PORT": "8001",
                "WEB_ADMIN_MODEL_DEFAULTS_FILE": str(tmp_path / "obsolete-models.json"),
            }
        ),
    )
    monkeypatch.chdir(tmp_path)
    assert load_development_environment() == 8001
    assert "WEB_ADMIN_MODEL_DEFAULTS_FILE" not in os.environ
    settings = Settings(
        database_url="postgresql+asyncpg://test@localhost/test",
        secret=SecretStr("synthetic-secret-at-least-32-characters"),
        encryption_key=SecretStr("A" * 43 + "="),
        data_dir=tmp_path,
    )
    assert settings.model_defaults_file == development.BACKEND_ROOT / "config/model-defaults.json"
    explicit = tmp_path / "isolated-models.json"
    monkeypatch.setenv("WEB_ADMIN_MODEL_DEFAULTS_FILE", str(explicit))
    assert load_development_environment() == 8001
    assert os.environ["WEB_ADMIN_MODEL_DEFAULTS_FILE"] == str(explicit)


@pytest.mark.parametrize("field,value", [("owner", "another-app"), ("mode", "production")])
def test_rejects_wrong_configuration_owner(tmp_path: Path, field: str, value: str) -> None:
    payload = configuration({"WEB_ADMIN_BACKEND_PORT": "8001"})
    payload[field] = value
    write_config(tmp_path, payload)
    with pytest.raises(RuntimeError, match="归属"):
        load_development_environment()


@pytest.mark.parametrize(
    "payload",
    [
        [],
        None,
        configuration([]),
        configuration({"PATH": "synthetic"}),
        configuration({"WEB_ADMIN_BACKEND_PORT": 8001}),
        configuration({}),
    ],
)
def test_rejects_invalid_configuration_shape(tmp_path: Path, payload: object) -> None:
    write_config(tmp_path, payload)
    with pytest.raises((RuntimeError, ValueError)):
        load_development_environment()


@pytest.mark.parametrize("port", ["0", "65536", "invalid"])
def test_rejects_invalid_port(tmp_path: Path, port: str) -> None:
    write_config(tmp_path, configuration({"WEB_ADMIN_BACKEND_PORT": port}))
    with pytest.raises((RuntimeError, ValueError)):
        load_development_environment()


@pytest.mark.parametrize("port", ["1", "65535"])
def test_explicit_environment_overrides_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, port: str
) -> None:
    write_config(
        tmp_path,
        configuration(
            {
                "WEB_ADMIN_BACKEND_PORT": "8001",
                "WEB_ADMIN_PUBLIC_ORIGIN": "http://localhost:5175",
            }
        ),
    )
    monkeypatch.setenv("WEB_ADMIN_BACKEND_PORT", port)
    assert load_development_environment() == int(port)
    assert os.environ["WEB_ADMIN_PUBLIC_ORIGIN"] == "http://localhost:5175"
    assert sys.pycache_prefix == str(tmp_path / ".superdsh-work/pycache")


def test_cache_is_configured_before_missing_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """初始化配置缺失也先建立外置缓存边界，不能等业务配置成功后才处理。"""
    monkeypatch.delenv("PYTHONPYCACHEPREFIX")
    monkeypatch.setattr(sys, "pycache_prefix", None)
    with pytest.raises(RuntimeError, match="web-admin:init"):
        load_development_environment()
    expected = str(tmp_path / ".superdsh-work/web-admin-tools/pycache")
    assert os.environ["PYTHONPYCACHEPREFIX"] == sys.pycache_prefix == expected
    assert Path(expected).is_dir()


def test_rejects_cache_in_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """显式环境变量不能使字节码重新落入生产代码目录。"""
    invalid = tmp_path / "apps/web-admin/backend/app/__pycache__"
    monkeypatch.setenv("PYTHONPYCACHEPREFIX", str(invalid))
    with pytest.raises(RuntimeError, match=".superdsh-work"):
        configure_runtime_cache()
    assert not invalid.exists()


@pytest.mark.parametrize(
    "failure,reason",
    [
        (ConnectionRefusedError("synthetic-password"), "连接失败"),
        (TimeoutError("synthetic-password"), "连接超时"),
        (socket.gaierror("synthetic-password"), "连接失败"),
    ],
)
def test_migration_connection_diagnostic_is_actionable_and_redacted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: OSError, reason: str
) -> None:
    """拒绝、超时和 DNS 故障只显示目标端点，不回显异常、账号、密码或 URL 参数。"""

    def fail(config: object, revision: str) -> None:
        raise failure

    monkeypatch.setattr(development_migrations.command, "upgrade", fail)
    with pytest.raises(RuntimeError, match=f"PostgreSQL {reason}") as captured:
        development_migrations.migrate_development_database(
            tmp_path / "alembic.ini",
            "postgresql+asyncpg://synthetic-user:synthetic-password@127.0.0.1:55435/"
            "synthetic-database?token=synthetic-token",
        )
    detail = str(captured.value)
    assert "127.0.0.1:55435" in detail
    assert "corepack yarn web-admin:init" in detail
    assert "uv run python main.py" in detail
    assert "synthetic-" not in detail
    assert captured.value.__suppress_context__


def test_migration_windows_refusal_and_ipv6_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """模拟没有通用 errno 的 WinError 1225，同时保留可辨识的 IPv6 地址边界。"""

    class WindowsRefusal(OSError):
        winerror = 1225

    failure = WindowsRefusal("synthetic-password")

    def fail(config: object, revision: str) -> None:
        raise failure

    monkeypatch.setattr(development_migrations.command, "upgrade", fail)
    with pytest.raises(RuntimeError, match=r"PostgreSQL 连接失败（\[::1\]:55435）"):
        development_migrations.migrate_development_database(
            tmp_path / "alembic.ini", "postgresql+asyncpg://synthetic:synthetic@[::1]:55435/db"
        )


@pytest.mark.parametrize(
    "failure",
    [
        FileNotFoundError("missing migration file"),
        PermissionError("migration file is not readable"),
        RuntimeError("目标存在未知结构"),
    ],
)
def test_migration_non_connection_failure_is_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    """文件权限、迁移文件缺失及未知数据库结构不能被误报为网络故障。"""

    def fail(config: object, revision: str) -> None:
        raise failure

    monkeypatch.setattr(development_migrations.command, "upgrade", fail)
    with pytest.raises(type(failure)) as captured:
        development_migrations.migrate_development_database(
            tmp_path / "alembic.ini", "postgresql+asyncpg://synthetic:synthetic@localhost/db"
        )
    assert captured.value is failure


def test_migration_success_uses_original_alembic_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """正常启动仍只执行既有 Alembic head，不绕过迁移或增加第二条初始化流程。"""
    from alembic.config import Config

    observed: list[tuple[str | None, str]] = []

    def upgrade(config: Config, revision: str) -> None:
        observed.append((config.config_file_name, revision))

    monkeypatch.setattr(development_migrations.command, "upgrade", upgrade)
    config_path = tmp_path / "alembic.ini"
    development_migrations.migrate_development_database(
        config_path, "postgresql+asyncpg://synthetic:synthetic@localhost/db"
    )
    assert observed == [(str(config_path), "head")]

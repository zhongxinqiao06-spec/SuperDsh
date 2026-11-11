"""真实 PostgreSQL/Redis 基础 fixture，每个测试独立数据库并可靠删除。"""

import asyncio
import os
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.main import create_app

ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def platform_settings() -> dict[str, object]:
    """允许测试显式覆盖应用配置，默认关闭配置初始化以保留兼容注册覆盖。"""
    return {}


@pytest.fixture
async def platform_configuration(
    platform_settings: dict[str, object],
) -> AsyncIterator[Settings]:
    """缺少环境直接失败；绝不连接产品默认库或以 skip 假绿。"""
    source = make_url(os.environ["WEB_ADMIN_TEST_DATABASE_URL"])
    run_root = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    assert run_root.is_relative_to(ROOT / ".superdsh-work" / "web-admin-validation")
    database_name = "validation_backend_" + uuid4().hex
    database_url = source.set(database=database_name).render_as_string(hide_password=False)
    control_engine = create_async_engine(source, isolation_level="AUTOCOMMIT")
    control = await control_engine.connect()
    await control.exec_driver_sql(f'CREATE DATABASE "{database_name}"')
    environment = {
        **os.environ,
        "WEB_ADMIN_DATABASE_URL": database_url,
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(ROOT / "apps/web-admin/backend/alembic.ini"),
            "upgrade",
            "head",
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        output, _ = await process.communicate()
        assert process.returncode == 0, output.decode(errors="replace")
        settings = Settings(
            database_url=database_url,
            redis_url=os.environ["WEB_ADMIN_TEST_REDIS_URL"],
            secret=SecretStr("synthetic-signing-key-at-least-32-characters"),
            encryption_key=SecretStr("A" * 43 + "="),
            data_dir=run_root / database_name,
            setup_token=SecretStr("synthetic-setup-token"),
            setup_token_expires_at=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
            initial_admin_username="",
            initial_admin_password=SecretStr(""),
            initial_admin_display_name="",
            public_origin="http://localhost:5175",
            use_langgraph=True,
            model_defaults_file=None,
        )
        settings = Settings.model_validate({**settings.model_dump(), **platform_settings})
        yield settings
    finally:
        await control.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
        await control.close()
        await control_engine.dispose()


@pytest.fixture
async def platform(platform_configuration: Settings) -> AsyncIterator[tuple[FastAPI, AsyncClient]]:
    """应用生命周期与独立测试数据库分开，允许重启测试完整释放旧监督器锁。"""
    application = create_app(platform_configuration)
    async with (
        application.router.lifespan_context(application),
        AsyncClient(
            transport=ASGITransport(application),
            base_url="http://localhost:5175",
            headers={"Origin": "http://localhost:5175"},
        ) as client,
    ):
        yield application, client


async def bootstrap(client: AsyncClient, prefix: str = "/api") -> dict[str, object]:
    """合成账号初始化，并安装当前 access token。"""
    response = await client.post(
        prefix + "/auth/register",
        json={
            "username": "testadmin",
            "displayName": "合成管理员",
            "password": "Synthetic-password-123!",
            "setupToken": "synthetic-setup-token",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    client.headers["Authorization"] = "Bearer " + data["accessToken"]
    return data


async def complete_initial_login(
    client: AsyncClient, identifier: str, password: str
) -> dict[str, object]:
    """管理员创建的合成账号必须先改密再重新登录，不能通过数据库绕过旧端安全流程。"""
    credentials = {"identifier": identifier, "password": password, "clientType": "native"}
    first = await client.post("/api/auth/login", json=credentials)
    assert first.status_code == 200, first.text
    assert first.json()["resetRequired"] is True
    headers = {"Authorization": "Bearer " + first.json()["accessToken"]}
    changed = await client.post(
        "/api/auth/change-password", headers=headers, json={"newPassword": password}
    )
    assert changed.status_code == 204, changed.text
    assert (await client.get("/api/auth/me", headers=headers)).status_code == 401
    result = await client.post("/api/auth/login", json=credentials)
    assert result.status_code == 200, result.text
    assert result.json()["resetRequired"] is False
    return result.json()

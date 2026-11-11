"""配置管理员的真实数据库初始化、并发与重启保护，不使用产品数据库。"""

import asyncio

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr, ValidationError

from app.infrastructure.configuration import Settings
from app.main import create_app
from app.modules.identity.service.identity import IdentityService

INITIAL_ADMIN = {
    "initial_admin_username": "admin",
    "initial_admin_password": SecretStr("admin123"),
    "initial_admin_display_name": "初始管理员",
}


@pytest.mark.parametrize("platform_settings", [INITIAL_ADMIN])
async def test_configured_admin_is_ready_before_first_request(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """空库启动后直接登录，公开配置不再要求初始化令牌。"""
    application, client = platform
    config = (await client.get("/api/auth/config")).json()
    assert config["needsBootstrap"] is False
    assert config["registrationOpen"] is False
    assert config["setupTokenExpiresAt"] is None
    login = await client.post(
        "/api/auth/login", json={"identifier": "admin", "password": "admin123"}
    )
    assert login.status_code == 200, login.text
    client.headers["Authorization"] = "Bearer " + login.json()["accessToken"]
    account = (await client.get("/api/auth/me")).json()
    assert account["username"] == "admin"
    assert account["displayName"] == "初始管理员"
    assert account["roles"] == ["admin"]
    registration = await client.post(
        "/api/auth/register",
        json={
            "username": "anotheradmin",
            "password": "Synthetic-password-123!",
            "setupToken": "synthetic-setup-token",
        },
    )
    assert registration.status_code == 403
    service: IdentityService = application.state.services.identity
    async with service.repository.transaction() as tx:
        users = await tx.users()
    assert len(users) == 1
    assert users[0].password_hash != "admin123"


async def test_concurrent_initialization_creates_only_one_admin(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """并发初始化共用身份事务锁，只有一次创建成功并保留同一账号。"""
    application, client = platform
    service: IdentityService = application.state.services.identity
    results = await asyncio.gather(
        *(service.initialize_admin("admin", "admin123", "初始管理员") for _ in range(4))
    )
    assert sum(account is not None for account in results) == 1
    async with service.repository.transaction() as tx:
        users = await tx.users()
    assert len(users) == 1 and users[0].roles == ["admin"]
    assert (
        await client.post("/api/auth/login", json={"identifier": "admin", "password": "admin123"})
    ).status_code == 200


@pytest.mark.parametrize("platform_settings", [INITIAL_ADMIN])
async def test_restart_preserves_changed_password_and_permissions(
    platform_configuration: Settings,
) -> None:
    """真实应用重新装配仍保留改密与权限，配置变更不会生成第二个管理员。"""
    application = create_app(platform_configuration)
    async with application.router.lifespan_context(application):
        service: IdentityService = application.state.services.identity
        login = await service.login("admin", "admin123", None, "Validation")
        await service.change_password(login.account, "Synthetic-changed-password!", None, None)
        async with service.repository.transaction() as tx:
            await tx.lock()
            roles = await tx.roles()
            admin_role = next(role for role in roles if role.id == "admin")
            admin_role.permissions = ["users.read"]
            await tx.save_role(admin_role)
            before = (await tx.users())[0]
    restarted = create_app(platform_configuration)
    async with (
        restarted.router.lifespan_context(restarted),
        AsyncClient(transport=ASGITransport(restarted), base_url="http://localhost:5175") as client,
    ):
        assert (
            await client.post(
                "/api/auth/login", json={"identifier": "admin", "password": "admin123"}
            )
        ).status_code == 401
        response = await client.post(
            "/api/auth/login",
            json={"identifier": "admin", "password": "Synthetic-changed-password!"},
        )
        assert response.status_code == 200, response.text
        client.headers["Authorization"] = "Bearer " + response.json()["accessToken"]
        assert (await client.get("/api/auth/me")).json()["permissions"] == ["users.read"]
        restarted_identity: IdentityService = restarted.state.services.identity
        assert (
            await restarted_identity.initialize_admin(
                "replacement", "Synthetic-replacement-password!", "新配置名称"
            )
        ) is None
        async with restarted_identity.repository.transaction() as tx:
            after = await tx.users()
        assert len(after) == 1
        assert after[0] == before


@pytest.mark.parametrize(
    "overrides",
    [
        {"initial_admin_username": "admin"},
        {"initial_admin_password": SecretStr("admin123")},
        {**INITIAL_ADMIN, "initial_admin_username": "invalid user"},
        {**INITIAL_ADMIN, "initial_admin_password": SecretStr("short")},
    ],
)
def test_initial_admin_rejects_incomplete_or_invalid_config(overrides: dict[str, object]) -> None:
    """非法配置在启动边界被拒绝，不能悄悄跳过初始化或保存不符合约束的账号。"""
    with pytest.raises(ValidationError):
        Settings.model_validate(
            {
                "database_url": "postgresql+asyncpg://localhost/synthetic_validation",
                "secret": SecretStr("synthetic-signing-key-at-least-32-characters"),
                "encryption_key": SecretStr("A" * 43 + "="),
                "data_dir": __file__,
                "initial_admin_username": "",
                "initial_admin_password": SecretStr(""),
                **overrides,
            }
        )

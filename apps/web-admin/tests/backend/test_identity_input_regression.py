"""真实隔离数据库验证身份输入边界，不复用产品账号。"""

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient


async def test_real_profile_admin_name_and_login_extension(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """实库验证资料、管理创建/更新规则，登录扩展字段不会修改用户权限。"""
    _, client = platform
    await bootstrap(client)
    accepted = await client.put("/api/auth/me/profile", json={"displayName": " 合成显示名称 "})
    assert accepted.status_code == 200 and accepted.json()["displayName"] == "合成显示名称"
    for value in (None, " ", "a" * 65, "name\x00test"):
        response = await client.put("/api/auth/me/profile", json={"displayName": value})
        assert (
            response.status_code == 422
            and response.json()["detail"] == "display name must be 1-64 characters"
        )
    body = {"username": "name-check-user", "password": "Synthetic-name-check-password!"}
    rejected = await client.post("/api/admin/users", json=body)
    assert (
        rejected.status_code == 422
        and rejected.json()["detail"] == "display name must be 1-64 characters"
    )
    created = await client.post("/api/admin/users", json={**body, "displayName": " 成员名称 "})
    assert created.status_code == 201 and created.json()["displayName"] == "成员名称"
    rejected = await client.patch(
        "/api/admin/users/" + created.json()["userId"], json={"displayName": "\x01"}
    )
    assert rejected.status_code == 422
    logged = await client.post(
        "/api/auth/login",
        json={
            "identifier": "testadmin",
            "password": "Synthetic-password-123!",
            "roles": ["forged"],
            "extraMetadata": {"unused": True},
        },
    )
    assert logged.status_code == 200 and logged.json()["roles"] == ["admin"]


async def test_desktop_android_refresh_payload_preserves_existing_session_name(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """复用真实客户端请求字段验证ASGI及数据库，刷新不重命名会话或泄漏Cookie。"""
    _, client = platform
    await bootstrap(client)
    for prefix, name in (("/api", "SuperDsh Android"), ("/api/v2", "SuperDsh Desktop")):
        original = "Original " + name
        logged = await client.post(
            prefix + "/auth/login",
            json={
                "identifier": "testadmin",
                "password": "Synthetic-password-123!",
                "clientType": "native",
                "clientName": original,
            },
        )
        assert logged.status_code == 200, logged.text
        token = logged.json()["refreshToken"]
        renewed = await client.post(
            prefix + "/auth/refresh", json={"refreshToken": token, "clientName": name}
        )
        assert renewed.status_code == 200, renewed.text
        assert renewed.json()["refreshToken"] != token and "set-cookie" not in renewed.headers
        sessions = (
            await client.get(
                prefix + "/auth/sessions",
                headers={"Authorization": "Bearer " + renewed.json()["accessToken"]},
            )
        ).json()["sessions"]
        current = next(row for row in sessions if row["current"])
        assert current["clientName"] == original

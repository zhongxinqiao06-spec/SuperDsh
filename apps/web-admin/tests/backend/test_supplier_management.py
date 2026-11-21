"""真实会话验证供应商密钥边界、套餐持久化与目录投影。"""

import httpx
from conftest import bootstrap
from fastapi import FastAPI

from app.infrastructure.crypto import password_hash
from app.modules.models.entity.vo.startup_vo import StartupModels
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.startup_service import StartupModelService


async def test_provider_admin_secret_and_plan(platform: tuple[FastAPI, httpx.AsyncClient]) -> None:
    app, client = platform
    await bootstrap(client)
    salt = (await client.post("/api/auth/password-salt", json={"identifier": "testadmin"})).json()[
        "salt"
    ]
    proof = password_hash("Synthetic-password-123!", salt).split("$")[-1]
    base = "/api/admin/models/connections"
    setup = {
        "name": "test wallet",
        "baseUrl": "https://api.deepseek.com",
        "adapter": "openai-completions",
    }
    original = "synthetic-original-secret"
    updated = "synthetic-updated-secret"
    saved = (await client.post(base, json={**setup, "apiKey": original})).json()
    path = base + "/" + saved["id"]
    patch = {**setup, "revision": saved["revision"], "apiKey": updated}
    assert (await client.patch(path, json=patch)).status_code == 403
    assert (
        await client.post(path + "/reveal-key", json={"passwordVerifier": "wrong"})
    ).status_code == 403
    value = await client.post(path + "/reveal-key", json={"passwordVerifier": proof})
    assert value.json() == {"apiKey": original} and "no-store" in value.headers["cache-control"]
    plan = {"plan": "test", "unit": "CNY", "quota": 120.0, "remaining": 0.0}
    changed = await client.patch(
        path, json={**patch, "subscription": plan, "passwordVerifier": proof}
    )
    assert changed.status_code == 200 and changed.json()["subscription"] == plan
    # 模拟容器下次启动时再次读取历史配置，已轮换的凭据与登记额度应保留。
    configs = app.state.services.model_configurations
    seed = StartupModels.model_validate(
        {"connections": [{**setup, "id": saved["id"], "apiKey": original}]}
    )
    await StartupModelService(configs.database, configs.cipher, configs.role_exists).synchronize(
        seed
    )
    assert (await client.post(path + "/reveal-key", json={"passwordVerifier": proof})).json()[
        "apiKey"
    ] == updated
    catalog = await client.get("/api/admin/models/configurations")
    assert (
        next(item for item in catalog.json()["connections"] if item["id"] == saved["id"])[
            "subscription"
        ]
        == plan
    )
    assert (
        original not in catalog.text and updated not in catalog.text and proof not in catalog.text
    )

    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET" and request.headers["authorization"] == "Bearer " + updated
        if request.url.path == "/user/balance":
            return httpx.Response(
                200, json={"balance_infos": [{"currency": "CNY", "total_balance": "3.50"}]}
            )
        return httpx.Response(200, json={"data": [{"id": "synthetic-model"}]})

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(upstream)
    )
    detail = (await client.post(path + "/inspect")).json()
    assert detail["models"] == ["synthetic-model"] and detail["balances"] == [
        {"currency": "CNY", "amount": "3.50"}
    ]

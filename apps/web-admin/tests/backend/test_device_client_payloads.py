"""原生Android已发布请求字段在双入口执行真实配对，不只检查DTO能否解析。"""

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient


@pytest.mark.parametrize("prefix", ["/api", "/api/v2"])
async def test_android_pairing_claim_preserves_frozen_server_url(
    platform: tuple[FastAPI, AsyncClient], prefix: str
) -> None:
    """claim附带serverUrl必须可接收但不能篡改发起方冻结的连接地址。"""
    _, client = platform
    await bootstrap(client, prefix)
    device = (await client.post(prefix + "/connectors", json={"name": "Android已有设备"})).json()
    pending = await client.post(
        prefix + "/pairing/start", json={"serverUrl": "https://original.example.test"}
    )
    assert pending.status_code == 200, pending.text
    pair = pending.json()
    claimed = await client.post(
        prefix + "/pairing/claim",
        json={
            "code": pair["code"],
            "name": "Android扫码显示名",
            "serverUrl": "https://claim.example.test",
            "connectorId": device["connector"]["id"],
            "connectorToken": device["connectorToken"],
        },
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["connector"]["id"] == device["connector"]["id"]
    polled = await client.post(prefix + "/pairing/poll", json={"pairingId": pair["pairingId"]})
    assert polled.status_code == 200 and polled.json()["status"] == "claimed"
    assert polled.json()["config"] == {
        "serverUrl": "https://original.example.test",
        "connectorId": device["connector"]["id"],
        "connectorToken": device["connectorToken"],
    }
    assert (
        await client.post(prefix + "/pairing/poll", json={"pairingId": pair["pairingId"]})
    ).status_code == 409

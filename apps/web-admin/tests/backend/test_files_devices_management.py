"""文件引用、旧分页查询与设备元数据协议使用隔离数据库回归。"""

import asyncio

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient


async def test_file_references_trash_alias_and_version_contract(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    owner = await app.state.services.identity.authenticate(str(login["accessToken"]))
    entry = await app.state.services.files.ingest(
        owner, "合成旧协议.txt", b"synthetic", "text/plain"
    )
    identifier = entry["id"]
    await app.state.services.files.bind(owner, identifier, "session", "synthetic-session")
    response = await client.get("/api/files", params={"q": "合成旧协议", "pageSize": 10})
    assert response.status_code == 200 and response.json()["total"] == 1
    assert response.json()["items"][0]["references"] == [
        {"fileId": identifier, "kind": "session", "resourceId": "synthetic-session"}
    ]
    assert (await client.post(f"/api/files/{identifier}/trash")).status_code == 409
    assert (await client.get(f"/api/files/{identifier}/versions")).json()["items"][0]["references"]
    empty = await client.get("/api/files", params={"q": "合成旧协议", "trash": "true"})
    assert empty.json()["total"] == 0
    other = await app.state.services.files.ingest(owner, "可回收合成.txt", b"other", "text/plain")
    assert (await client.post(f"/api/files/{other['id']}/trash")).status_code == 200
    assert (await client.get("/api/files", params={"trash": "true"})).json()["total"] == 1
    assert (await client.post(f"/api/files/{other['id']}/restore")).status_code == 200


async def test_bind_and_trash_race_never_publish_deleted_reference(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    owner = await app.state.services.identity.authenticate(str(login["accessToken"]))
    files = app.state.services.files
    entry = await files.ingest(owner, "并发引用.txt", b"race", "text/plain")
    outcomes = await asyncio.gather(
        files.bind(owner, entry["id"], "session", "synthetic-race"),
        files.trash(owner, entry["id"]),
        return_exceptions=True,
    )
    assert sum(isinstance(item, Exception) for item in outcomes) == 1
    versions = await files.versions(owner, entry["id"])
    value = versions["items"][0]
    assert not (value["deletedAt"] and value["references"])


async def test_inventory_pagination_owner_search_and_storage_aggregates(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    owner = await app.state.services.identity.authenticate(str(login["accessToken"]))
    for name in ("合成分页甲", "合成分页乙"):
        assert (await client.post("/api/connectors", json={"name": name})).status_code == 200
    result = (
        await client.get(
            "/api/admin/devices", params={"search": "合成分页", "page": 2, "pageSize": 1}
        )
    ).json()
    assert (
        result["total"] == 2
        and len(result["devices"]) == 1
        and result["devices"][0]["username"] == owner.username
    )
    assert (await client.get("/api/admin/devices", params={"page": 0})).status_code == 422
    await app.state.services.files.ingest(owner, "合成用量.txt", b"storage", "text/plain")
    usage = (await client.get("/api/admin/storage/usage")).json()
    assert usage["items"] == [{"storage_id": "local", "objects": "1", "bytes": "7"}]
    migration = (await client.get("/api/admin/storage/migrations")).json()
    assert migration["items"] == [] and migration["records"] == []

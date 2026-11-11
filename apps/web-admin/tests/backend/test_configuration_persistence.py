"""组合 Schema 的 writeOnly 秘密不得进入当前记录或历史快照，失败更新保持原密文。"""

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text


async def test_nested_secret_update_preserves_old_and_failed_update_rolls_back(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    schema = {
        "type": "object",
        "$defs": {
            "connection": {
                "type": "object",
                "required": ["token"],
                "properties": {
                    "token": {"type": "string", "writeOnly": True},
                    "label": {"type": "string"},
                },
            }
        },
        "properties": {
            "connection": {"$ref": "#/$defs/connection"},
            "entries": {"type": "array", "items": {"$ref": "#/$defs/connection"}},
            "union": {"anyOf": [{"type": "string"}, {"type": "string", "writeOnly": True}]},
        },
        "patternProperties": {"^secret_": {"type": "string", "writeOnly": True}},
        "additionalProperties": {"type": "string", "writeOnly": True},
    }
    manifest = {
        "id": "nested-config-fixture",
        "version": "frozen-fixture",
        "runtime": "python",
        "entrypoint": "tool.py",
        "tools": [{"id": "nested", "configurationSchema": schema}],
    }
    source = (
        await client.post(
            "/api/resources/extensions/install",
            json={"name": "Nested configuration", "manifest": manifest},
        )
    ).json()
    implementation = {"sourceId": source["id"], "toolId": "nested", "version": "frozen-fixture"}
    settings = {
        "connection": {"token": "nested-secret", "label": "before"},
        "entries": [{"token": "array-secret", "label": "shown"}],
        "union": "union-secret",
        "secret_extra": "pattern-secret",
        "unlisted": "additional-secret",
    }
    created = await client.post(
        "/api/resources/tools",
        json={"name": "Nested tool", "implementation": implementation, "settings": settings},
    )
    assert created.status_code == 200, created.text
    tool = created.json()
    assert tool["settings"] == {"connection": {"label": "before"}, "entries": [{"label": "shown"}]}
    changed = await client.put(
        "/api/resources/tools/" + tool["id"],
        json={"name": "Nested tool", "version": 1, "settings": {"connection": {"label": "after"}}},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["settings"]["connection"] == {"label": "after"}
    failed = await client.put(
        "/api/resources/tools/" + tool["id"],
        json={"name": "Nested tool", "version": 2, "settings": {"connection": {"label": 123}}},
    )
    assert failed.status_code == 422
    async with app.state.database.engine.connect() as connection:
        values = (
            await connection.execute(
                text("select payload, secret_ciphertext, version from resources where id=:id"),
                {"id": tool["id"]},
            )
        ).one()
        snapshots = list(
            (
                await connection.execute(
                    text("select snapshot from resource_versions where resource_id=:id"),
                    {"id": tool["id"]},
                )
            ).scalars()
        )
    assert values.version == 2 and len(snapshots) == 2
    for secret in (
        "nested-secret",
        "array-secret",
        "union-secret",
        "pattern-secret",
        "additional-secret",
    ):
        assert secret not in str(values.payload) + str(snapshots)
    resource_service = app.state.services.resources
    decrypted = resource_service.cipher.open(values.secret_ciphertext, tool["id"])
    assert "nested-secret" in decrypted and '"after"' in decrypted
    assert account.user_id == login["userId"]

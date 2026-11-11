"""真实 S3 签名、对象迁移和故障恢复使用隔离 PostgreSQL/MinIO 验证。"""

from datetime import UTC, datetime, timedelta

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from fixtures.minio_storage import minio_storage


async def test_real_s3_migration_checksum_and_failed_target_preserve_source(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    login = await bootstrap(client)
    account = await application.state.services.identity.authenticate(login["accessToken"])
    files = application.state.services.files
    async with minio_storage() as specification:
        created = await client.post("/api/admin/storage/connections", json=specification)
        assert created.status_code == 200, created.text
        connection = created.json()
        assert "credentials" not in connection and connection["credentialConfigured"]
        storage = connection["id"]
        assert (
            await client.post(f"/api/admin/storage/connections/{storage}/check")
        ).status_code == 200
        file = await files.ingest(
            account, "合成迁移.txt", b"migrated-through-real-s3", "text/plain"
        )
        identifier = file["id"]
        moved = await client.post(
            f"/api/files/{identifier}/migrate", json={"targetStorageId": storage}
        )
        assert moved.status_code == 200 and moved.json()["state"] == "completed", moved.text
        assert (
            await client.get(f"/api/files/{identifier}/content")
        ).content == b"migrated-through-real-s3"
        assert (
            await client.post(f"/api/files/{identifier}/migrate", json={"targetStorageId": "local"})
        ).status_code == 200
        invalid = await client.patch(
            f"/api/admin/storage/connections/{storage}",
            json={
                **specification,
                "revision": connection["revision"],
                "credentials": {
                    "accessKeyId": "synthetic-invalid",
                    "secretAccessKey": "synthetic-invalid-secret",
                },
            },
        )
        assert invalid.status_code == 200
        assert (
            await client.post(f"/api/files/{identifier}/migrate", json={"targetStorageId": storage})
        ).status_code == 503
        assert (
            await client.get(f"/api/files/{identifier}/content")
        ).content == b"migrated-through-real-s3"
        receipts = (await client.get("/api/admin/storage/migrations")).json()
        assert any(row["state"] == "failed" for row in receipts["records"])
        assert receipts["cleanup"] and receipts["cleanup"][0]["state"] == "failed"
        restored = await client.patch(
            f"/api/admin/storage/connections/{storage}",
            json={**specification, "revision": invalid.json()["revision"]},
        )
        assert restored.status_code == 200
        await files.maintenance.recover()
        assert not (await client.get("/api/admin/storage/migrations")).json()["cleanup"]


async def test_expired_s3_file_cleanup_failure_retains_durable_object_receipt(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, client = platform
    login = await bootstrap(client)
    account = await application.state.services.identity.authenticate(login["accessToken"])
    files = application.state.services.files
    async with minio_storage() as specification:
        created = (await client.post("/api/admin/storage/connections", json=specification)).json()
        storage = created["id"]
        settings = (await client.get("/api/admin/storage")).json()
        assert (
            await client.put(
                "/api/admin/storage",
                json={
                    "activeConnectionId": storage,
                    "revision": settings["revision"],
                    "policy": settings["policy"],
                },
            )
        ).status_code == 200
        file = await files.ingest(account, "到期清理.txt", b"durable-cleanup-target", "text/plain")
        identifier = file["id"]
        assert (await client.post(f"/api/files/{identifier}/trash")).status_code == 200
        async with files.repository.transaction() as dao:
            row = await dao.entry(identifier, account.user_id)
            assert row
            object_key = row.object_key
            row.deleted_at = datetime.now(UTC) - timedelta(days=40)
            await dao.save(row)
        invalid = await client.patch(
            f"/api/admin/storage/connections/{storage}",
            json={
                **specification,
                "revision": created["revision"],
                "credentials": {
                    "accessKeyId": "synthetic-invalid",
                    "secretAccessKey": "synthetic-invalid-secret",
                },
            },
        )
        assert invalid.status_code == 200
        cleanup = await client.post("/api/admin/storage/cleanup")
        assert cleanup.status_code == 200 and cleanup.json() == {
            "removed": 0,
            "pending": 1,
            "scheduled": 1,
        }, cleanup.text
        assert (await client.get(f"/api/files/{identifier}")).status_code == 404
        async with files.repository.transaction() as dao:
            pending = await dao.pending_cleanup()
            assert len(pending) == 1 and pending[0].object_key == object_key
        assert (
            await client.patch(
                f"/api/admin/storage/connections/{storage}",
                json={**specification, "revision": invalid.json()["revision"]},
            )
        ).status_code == 200
        retried = await client.post("/api/admin/storage/cleanup")
        assert retried.json() == {"removed": 1, "pending": 0, "scheduled": 0}
        assert (await client.post("/api/admin/storage/cleanup")).json()["removed"] == 0

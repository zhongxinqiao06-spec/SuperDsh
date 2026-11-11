"""迁移拒绝接管未知结构，生产静态入口不吞 API 错误。"""

import asyncio
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from conftest import ROOT
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from starlette.responses import JSONResponse

from app.api.static import static_router
from app.infrastructure.errors import DomainError


async def test_unknown_database_is_not_auto_stamped(platform: tuple[FastAPI, AsyncClient]) -> None:
    application, _ = platform
    async with application.state.database.engine.begin() as connection:
        await connection.execute(text("DROP TABLE alembic_version"))
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "alembic",
        "-c",
        str(ROOT / "apps/web-admin/backend/alembic.ini"),
        "upgrade",
        "head",
        env={**os.environ, "WEB_ADMIN_DATABASE_URL": application.state.settings.database_url},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()
    assert process.returncode != 0
    assert "RuntimeError" in output.decode(errors="replace")
    async with application.state.database.engine.connect() as connection:
        assert await connection.scalar(text("select count(*) from roles")) == 2


async def test_expired_bootstrap_remains_expired(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    identity = app.state.services.identity
    identity.setup_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    response = await client.post(
        "/api/auth/register",
        json={
            "username": "testadmin",
            "password": "Synthetic-password-123!",
            "setupToken": "synthetic-setup-token",
        },
    )
    assert response.status_code == 401
    assert (await client.get("/api/auth/config")).json()["needsBootstrap"] is True


async def test_production_spa_keeps_api_and_assets_404() -> None:
    root = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / "static-test"
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text("<html>synthetic app</html>", encoding="utf-8")
    app = FastAPI()

    @app.exception_handler(DomainError)
    async def error_handler(request: object, error: DomainError) -> JSONResponse:
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    app.include_router(static_router(root))
    async with AsyncClient(transport=ASGITransport(app), base_url="http://localhost") as client:
        assert "synthetic app" in (await client.get("/console/users")).text
        for path in (
            "/api/missing",
            "/ws/missing",
            "/health/missing",
            "/missing.js",
            "/..%2Foutside",
        ):
            assert (await client.get(path)).status_code == 404

"""使用既有隔离 PostgreSQL 创建本轮浏览器专属库，退出时可靠清理库并保留证据。"""

import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

ROOT = Path(__file__).resolve().parents[4]


async def run() -> None:
    root = ROOT
    source = await asyncio.to_thread(Path(sys.argv[1]).resolve)
    output = source.parent / "series-browser"
    if not source.is_relative_to(root / ".superdsh-work/web-admin-validation"):
        raise ValueError("仅允许隔离环境配置")
    environment = json.loads(source.read_text(encoding="utf-8-sig"))
    control_url = make_url(environment["WEB_ADMIN_TEST_DATABASE_URL"])
    database = "validation_series_ui_" + uuid4().hex
    output.mkdir(parents=True, exist_ok=True)
    environment.update(
        WEB_ADMIN_TEST_DATABASE_URL=control_url.set(database=database).render_as_string(
            hide_password=False
        ),
        WEB_ADMIN_VALIDATION_DIR=str(output),
        WEB_ADMIN_E2E_USERNAME="foundation-admin",
        WEB_ADMIN_E2E_PASSWORD="Synthetic-series-browser!",
        PYTHONPATH=os.pathsep.join(
            [str(root / "apps/web-admin/backend"), str(root / "apps/web-admin/tests")]
        ),
    )
    runner = output / "run.mjs"
    module = (root / "apps/web-admin/tests/e2e/run-live.ts").as_uri()
    runner.write_text(
        f"import {{ runLiveBrowser }} from {json.dumps(module)}\nawait runLiveBrowser(process.env, ['series-workflow-live.spec.ts'])\n",
        encoding="utf-8",
    )
    engine = create_async_engine(control_url, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
            try:
                process = await asyncio.create_subprocess_exec(
                    "node", str(runner), cwd=root, env=environment
                )
                code = await process.wait()
                if code:
                    raise SystemExit(code)
            finally:
                await connection.exec_driver_sql(
                    f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'
                )
                (output / "cleanup.json").write_text(
                    json.dumps({"database": database, "dropped": True}), encoding="utf-8"
                )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(run())

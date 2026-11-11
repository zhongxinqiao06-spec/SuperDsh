"""仅装配新应用并采集实际路由/OpenAPI；不启动服务、数据库或执行引擎。"""

import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi.routing import iter_route_contexts
from pydantic import SecretStr
from starlette.routing import WebSocketRoute

from app.infrastructure.configuration import Settings
from app.main import create_app
from architecture import inspect_python


async def collect(destination: Path) -> None:
    """报告位置必须属于统一验证目录，配置全部为合成值且不进入应用生命周期。"""
    root = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    destination = await asyncio.to_thread(destination.resolve)
    if not destination.is_relative_to(root / ".superdsh-work/web-admin-validation"):
        raise ValueError("差分清单输出路径越界")
    settings = Settings(
        database_url="postgresql+asyncpg://synthetic:synthetic@127.0.0.1:1/unused",
        redis_url="redis://127.0.0.1:1/0",
        secret=SecretStr("synthetic-parity-key-never-used-for-login"),
        encryption_key=SecretStr("A" * 43 + "="),
        data_dir=destination.parent / "runtime",
        initial_admin_username="",
        initial_admin_password=SecretStr(""),
        static_dir=None,
    )
    app = create_app(settings)
    try:
        routes: list[dict[str, str]] = []
        for context in iter_route_contexts(app.routes):
            if context.path is None:
                continue
            websocket = isinstance(context.original_route, WebSocketRoute)
            for method in ["WEBSOCKET"] if websocket else sorted(context.methods or []):
                routes.append(
                    {
                        "transport": "websocket" if websocket else "http",
                        "method": method,
                        "path": context.path,
                    }
                )
        issues: list[dict[str, str]] = []
        source_root = root / "apps/web-admin/backend/app"
        for path in source_root.rglob("*.py"):
            relative = "/app/" + path.relative_to(source_root).as_posix()
            issues.extend(
                {"path": relative, "detail": item}
                for item in inspect_python(relative, path.read_text(encoding="utf-8"))
            )
        result = {
            "routes": routes,
            "openapi": app.openapi(),
            "architectureIssues": issues,
            "lifespanStarted": False,
        }
        destination.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    finally:
        await app.state.database.close()


if __name__ == "__main__":
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    asyncio.run(collect(Path(sys.argv[1])))

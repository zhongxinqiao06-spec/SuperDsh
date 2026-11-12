"""生产只迁移明确配置的新库，然后交给单一 Python 服务接管信号与退出。"""

import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


def load_compose_environment() -> None:
    """从持久卷装配运行配置；显式数据库地址与现有部署设置优先。"""
    path = os.environ.get("WEB_ADMIN_COMPOSE_CREDENTIALS")
    if not path:
        return
    credentials = json.loads(Path(path).read_text())
    postgres = quote(credentials["WEB_ADMIN_POSTGRES_PASSWORD"], safe="")
    redis = quote(credentials["WEB_ADMIN_REDIS_PASSWORD"], safe="")
    origin = os.environ.get("WEB_ADMIN_PUBLIC_ORIGIN")
    if not origin:
        port = os.environ.get("WEB_ADMIN_FRONTED_PORT", "5174").rsplit(":", 1)[-1]
        origin = f"http://localhost:{port}"
        os.environ["WEB_ADMIN_PUBLIC_ORIGIN"] = origin
        os.environ["WEB_ADMIN_ALLOW_REQUEST_ORIGIN"] = "true"
    admin = json.loads(Path(__file__).with_name("initial-admin.json").read_text())
    defaults = {
        "WEB_ADMIN_DATABASE_URL": f"postgresql+asyncpg://web_admin:{postgres}@postgres/web_admin",
        "WEB_ADMIN_REDIS_URL": f"redis://:{redis}@redis:6379/0",
        "WEB_ADMIN_SECRET": credentials["WEB_ADMIN_SECRET"],
        "WEB_ADMIN_ENCRYPTION_KEY": credentials["WEB_ADMIN_ENCRYPTION_KEY"],
        "WEB_ADMIN_QDRANT_API_KEY": credentials["WEB_ADMIN_QDRANT_API_KEY"],
        "WEB_ADMIN_STORAGE_PASSWORD": credentials["WEB_ADMIN_MINIO_PASSWORD"],
        "WEB_ADMIN_ALLOWED_ORIGINS": json.dumps([origin]),
        "WEB_ADMIN_INITIAL_ADMIN_USERNAME": admin["username"],
        "WEB_ADMIN_INITIAL_ADMIN_PASSWORD": admin["password"],
        "WEB_ADMIN_INITIAL_ADMIN_DISPLAY_NAME": admin["displayName"],
    }
    for key, value in defaults.items():
        if not os.environ.get(key):
            os.environ[key] = value


def main() -> None:
    """迁移失败立即退出，不带错误 schema 提供业务接口。"""
    load_compose_environment()
    backend = Path(__file__).resolve().parents[1] / "backend"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(backend / "alembic.ini"),
            "upgrade",
            "head",
        ],
        cwd=backend,
        check=True,
    )
    os.execv(
        sys.executable,
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:create_app",
            "--factory",
            "--loop",
            "app.infrastructure.event_loop:create_event_loop",
            "--host",
            "0.0.0.0",
            "--port",
            "8001",
            "--workers",
            "1",
            "--timeout-graceful-shutdown",
            "75",
        ],
    )


if __name__ == "__main__":
    main()

"""生产只迁移明确配置的新库，然后交给单一 Python 服务接管信号与退出。"""

import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    """迁移失败立即退出，不带错误 schema 提供业务接口。"""
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

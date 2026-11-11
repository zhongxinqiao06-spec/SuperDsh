"""统一命令行入口：读取独立配置、迁移新库，再启动可热重载的 Python API。"""

import argparse
import json
import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = BACKEND_ROOT.parents[2]


def configure_runtime_cache() -> None:
    """在配置读取和业务导入前固定缓存边界，重载及派生进程继承同一目录。"""
    work_root = (REPOSITORY_ROOT / ".superdsh-work").resolve()
    value = os.environ.get("PYTHONPYCACHEPREFIX") or sys.pycache_prefix
    cache = (
        Path(value).expanduser().resolve() if value else work_root / "web-admin-tools" / "pycache"
    )
    if cache == work_root or not cache.is_relative_to(work_root):
        raise RuntimeError("Python 缓存目录必须位于项目 .superdsh-work 内，不能指向源码目录")
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["PYTHONPYCACHEPREFIX"] = str(cache)
    sys.pycache_prefix = str(cache)


def load_development_environment() -> int:
    """复用初始化导出的同一份配置；环境变量显式覆盖，不生成或轮换密钥。"""
    configure_runtime_cache()
    root = Path(
        os.environ.get("WEB_ADMIN_CONFIG_ROOT", REPOSITORY_ROOT / ".superdsh-work/web-admin-dev")
    ).resolve()
    path = root / "config/backend-environment.json"
    if not path.is_file():
        raise RuntimeError("开发配置尚未初始化，请先在仓库根目录执行 corepack yarn web-admin:init")
    config = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(config, dict)
        or config.get("owner") != "superdsh-web-admin"
        or config.get("mode") != "development"
    ):
        raise RuntimeError("开发配置归属不符，拒绝启动")
    environment = config.get("environment")
    if not isinstance(environment, dict) or not all(
        isinstance(key, str) and key.startswith("WEB_ADMIN_") and isinstance(value, str)
        for key, value in environment.items()
    ):
        raise RuntimeError("开发环境配置格式无效，请重新执行 web-admin:init")
    for key, value in environment.items():
        # 模型文件默认由后端 config 定位，旧导出文件不能重新指回工作目录。
        # 用户在启动终端显式设置的同名环境变量仍由 Settings 正常读取。
        if key == "WEB_ADMIN_MODEL_DEFAULTS_FILE":
            continue
        os.environ.setdefault(key, value)
    port_value = os.environ.get("WEB_ADMIN_BACKEND_PORT")
    if port_value is None:
        raise RuntimeError("开发配置缺少后端端口，请重新执行 web-admin:init")
    port = int(port_value)
    if not 1 <= port <= 65535:
        raise RuntimeError("后端端口必须在 1 到 65535 之间")
    return port


def main() -> None:
    """单进程开发服务默认热重载；迁移或配置检查失败时不启动监听。"""
    configure_runtime_cache()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-reload", action="store_true", help="禁用开发热重载")
    args = parser.parse_args()
    port = load_development_environment()

    # 配置和缓存边界确定后才加载第三方库，原生 uv 负责环境与依赖准备。
    import uvicorn
    from pydantic import ValidationError

    from app.infrastructure.configuration import Settings
    from app.infrastructure.development_migrations import migrate_development_database
    from app.infrastructure.development_server import run_development_server

    try:
        settings = Settings()
    except ValidationError:
        # 配置错误只描述检查项，不能把校验器携带的密钥原值输出到终端。
        raise RuntimeError("开发配置校验失败，请检查数据库、密钥和数据路径配置") from None
    migrate_development_database(BACKEND_ROOT / "alembic.ini", settings.database_url)
    run_development_server(
        uvicorn.Config(
            "app.main:create_app",
            factory=True,
            loop="app.infrastructure.event_loop:create_event_loop",
            host="127.0.0.1",
            port=port,
            workers=1,
            reload=not args.no_reload,
            reload_dirs=[
                str(path)
                for path in (BACKEND_ROOT / "app", BACKEND_ROOT / "toolkits")
                if path.is_dir()
            ]
            if not args.no_reload
            else None,
            timeout_graceful_shutdown=75,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        # 部分连接超时异常没有消息，保留异常类型，避免只输出空白错误。
        detail = str(error) or type(error).__name__
        print(f"后端开发启动失败：{detail}", file=sys.stderr)
        raise SystemExit(1) from None

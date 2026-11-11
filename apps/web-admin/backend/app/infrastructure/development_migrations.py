"""开发启动迁移适配：仅补充连接故障诊断，不改变迁移失败和事务语义。"""

import errno
import socket
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url

CONNECTION_ERRORS = {
    errno.ECONNREFUSED,
    errno.ECONNRESET,
    errno.ETIMEDOUT,
    errno.EHOSTUNREACH,
    errno.ENETUNREACH,
}


def migrate_development_database(config_path: Path, database_url: str) -> None:
    """执行迁移；网络不可达时显示脱敏端点和恢复命令，其余异常保持原样。"""
    try:
        command.upgrade(Config(str(config_path)), "head")
    except OSError as error:
        # Windows Proactor 的拒绝连接可能只带 WinError 1225，不能依赖异常子类。
        if not (
            isinstance(error, (ConnectionError, TimeoutError, socket.gaierror))
            or error.errno in CONNECTION_ERRORS
            or getattr(error, "winerror", None) == 1225
        ):
            raise
        url = make_url(database_url)
        host = url.host or "未配置主机"
        endpoint = f"[{host}]" if ":" in host else host
        endpoint = f"{endpoint}:{url.port or 5432}"
        reason = (
            "连接超时"
            if isinstance(error, TimeoutError) or error.errno == errno.ETIMEDOUT
            else "连接失败"
        )
        # 不拼接原始异常或完整 URL，避免用户名、密码及查询参数出现在终端。
        raise RuntimeError(
            f"PostgreSQL {reason}（{endpoint}）。请确认数据库服务已运行；"
            "使用项目开发依赖时，先启动 Docker，再在仓库根目录执行 "
            "corepack yarn web-admin:init，完成后重试 uv run python main.py。"
        ) from None

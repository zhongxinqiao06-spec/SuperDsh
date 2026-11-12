"""首次生成 Compose 服务凭据。已有数据库升级时导入原值，各依赖只挂载自己的密码。"""

import fcntl
import json
import os
import secrets
from pathlib import Path
from tempfile import NamedTemporaryFile

CONFIG = Path("/data/config/compose-credentials.json")
PASSWORDS = {
    "postgres": "WEB_ADMIN_POSTGRES_PASSWORD",
    "redis": "WEB_ADMIN_REDIS_PASSWORD",
    "qdrant": "WEB_ADMIN_QDRANT_API_KEY",
    "minio": "WEB_ADMIN_MINIO_PASSWORD",
}
KEYS = (*PASSWORDS.values(), "WEB_ADMIN_SECRET", "WEB_ADMIN_ENCRYPTION_KEY")


def write_atomic(path: Path, content: str, mode: int, uid: int) -> None:
    """在同一卷内原子替换文件，启动中断后可从主配置重新派发。"""
    with NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(content.encode())
            output.flush()
            os.fchown(output.fileno(), uid, uid)
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main() -> None:
    """主配置在各服务启动前提交，重试不轮换已发布的密码。"""
    supplied = {key: os.environ[key] for key in KEYS if os.environ.get(key)}
    with CONFIG.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if CONFIG.exists():
            values = json.loads(CONFIG.read_text())
            if any(not values.get(key) for key in KEYS) or any(
                values[key] != value for key, value in supplied.items()
            ):
                raise ValueError("持久配置不完整或与已有凭据不符，请恢复原部署配置")
        else:
            if any(Path("/existing-db").iterdir()) and supplied.keys() != set(KEYS):
                raise ValueError("已有数据库，首次切换请提供完整的原始 Compose 凭据")
            values = {key: supplied.get(key) or secrets.token_urlsafe(32) for key in KEYS}
            write_atomic(CONFIG, json.dumps(values), 0o400, 1000)
        for service, key in PASSWORDS.items():
            write_atomic(Path("/auth") / service / "password", values[key], 0o444, 0)


if __name__ == "__main__":
    main()

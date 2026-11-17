"""在真实后端镜像默认业务用户下检查制品读取权限，不连接数据库或修改文件。"""

import configparser
import json
import os
import stat
from pathlib import Path


def validate_backend() -> dict[str, int | str | list[str]]:
    """既检查 POSIX 制品权限，也实际打开启动所需配置、迁移、资源和引擎入口。"""
    geteuid = getattr(os, "geteuid", None)
    if geteuid is None:
        raise RuntimeError("镜像权限检查只能在 Linux 容器内运行")
    uid = int(geteuid())
    if uid == 0:
        raise RuntimeError("权限验收必须使用镜像默认非 root 业务用户")
    root = Path("/app")
    backend = root / "apps/web-admin/backend"
    # 正式模型配置是运行时只读挂载，不属于镜像源码，不检查其所有者或读取凭据内容。
    mounted_configuration = backend / "config/model-defaults.json"
    files = 0
    directories = 0
    dangling_links: list[str] = []
    for directory, names, filenames in os.walk(root):
        paths = [Path(directory), *(Path(directory) / name for name in [*names, *filenames])]
        for path in paths:
            if path == mounted_configuration:
                continue
            if path.is_symlink():
                # 可选 workspace 链接不等于制品权限错误，单独报告；必要入口在下方真实打开。
                if not path.exists():
                    dangling_links.append(str(path.relative_to(root)))
                    continue
                if not os.access(path, os.R_OK):
                    raise RuntimeError("制品链接不可读取：" + str(path.relative_to(root)))
                continue
            mode = path.stat()
            if mode.st_uid != 0 or mode.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                raise RuntimeError("制品必须由 root 所有且业务用户不可写：" + str(path))
            required = os.R_OK | (os.X_OK if path.is_dir() else 0)
            if not os.access(path, required):
                raise RuntimeError("业务用户缺少制品读取或遍历权限：" + str(path))
            if path.is_file() and mode.st_mode & stat.S_IXUSR and not os.access(path, os.X_OK):
                raise RuntimeError("制品执行权限未保留：" + str(path))
            files += path.is_file()
            directories += path.is_dir()
    ini = backend / "alembic.ini"
    configuration = configparser.ConfigParser(defaults={"here": str(backend)})
    with ini.open(encoding="utf-8") as stream:
        configuration.read_file(stream)
    migration_root = Path(configuration.get("alembic", "script_location"))
    if migration_root != backend / "migrations" or not migration_root.is_dir():
        raise RuntimeError("Alembic 配置缺少有效 migrations 位置")
    required_files = [
        migration_root / "env.py",
        backend / "app/main.py",
        root / "apps/web-admin/deployment/bootstrap.py",
        root / "apps/web-admin/engine-adapter/dist/host.mjs",
        root / "apps/desktop/plugins/harness/package.json",
    ]
    for path in required_files:
        with path.open("rb") as stream:
            if not stream.read(1):
                raise RuntimeError("必要制品为空：" + str(path))
    migrations = list((migration_root / "versions").glob("*.py"))
    resources = list((backend / "resources").rglob("*.json"))
    if not migrations or not resources:
        raise RuntimeError("镜像缺少迁移脚本或业务资源")
    for path in migrations:
        path.read_text(encoding="utf-8")
    for path in resources:
        json.loads(path.read_text(encoding="utf-8"))
    return {
        "status": "passed",
        "uid": uid,
        "files": files,
        "directories": directories,
        "migrations": len(migrations),
        "resources": len(resources),
        "danglingLinks": dangling_links,
    }


if __name__ == "__main__":
    print(json.dumps(validate_backend(), ensure_ascii=False))

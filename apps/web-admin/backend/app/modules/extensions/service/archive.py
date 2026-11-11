"""严格有界ZIP读取，安装阶段与技能数据导入共用路径边界。"""

import io
import stat
import zipfile

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.validation import package_path


def read_archive(
    data: bytes, *, max_files: int, max_bytes: int, per_file: int | None = None
) -> dict[str, bytes]:
    """在写盘前校验路径、链接和膨胀大小；流读取继续限制真实解压量。"""
    files: dict[str, bytes] = {}
    names: set[str] = set()
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > max_files:
                raise DomainError(413, "归档文件数量超过限制")
            for info in archive.infolist():
                name = package_path(info.filename.rstrip("/"))
                if name.casefold() in names or stat.S_ISLNK(info.external_attr >> 16):
                    raise DomainError(422, "归档包含重复路径或符号链接")
                names.add(name.casefold())
                if any(
                    part in {".git", ".venv", "node_modules", ".superdsh-install.json"}
                    for part in name.split("/")
                ):
                    raise DomainError(422, "归档不能携带安装目录或机器缓存")
                if info.is_dir():
                    continue
                if info.file_size > (per_file or max_bytes) or total + info.file_size > max_bytes:
                    raise DomainError(413, "归档解压内容超过限制")
                with archive.open(info) as stream:
                    content = stream.read(min(per_file or max_bytes, max_bytes - total) + 1)
                total += len(content)
                if total > max_bytes or len(content) > (per_file or max_bytes):
                    raise DomainError(413, "归档解压内容超过限制")
                files[name] = content
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError) as error:
        raise DomainError(422, "ZIP归档无法读取") from error
    return files

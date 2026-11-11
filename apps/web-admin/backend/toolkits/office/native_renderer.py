"""从固定依赖公开清单解析可选 LibreOfficeKit；不下载程序、不读取模型凭据。"""

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

from app.infrastructure.errors import DomainError


def bundled_manifest(repository: Path) -> Path | None:
    """Windows 可复用固定 DSH 安装树中的渲染器，版本完全由锁文件与清单管理。"""
    if os.name != "nt":
        return None
    candidate = (
        repository
        / "apps/desktop/plugins/harness/node_modules"
        / "@deepseek-ai/libreoffice-kit-win32-x64/prebuilds.json"
    )
    return candidate if candidate.is_file() else None


@dataclass(frozen=True)
class NativeRenderer:
    """仅接受安装清单声明且位于其包内的程序；每次转换使用独立配置目录。"""

    executable: Path
    program: Path

    @classmethod
    def load(cls, manifest: Path) -> "NativeRenderer":
        """配置错误明确失败，不回退到任意 PATH 程序或忽略清单完整性。"""
        try:
            root = manifest.resolve().parent
            value = json.loads(manifest.read_text("utf-8"))
            engine = value["engine"]
            executable = (root / engine["executable"]).resolve()
            program = (root / engine["programDirectory"]).resolve()
            if (
                engine["kind"] != "native"
                or value["status"] != "built"
                or not executable.is_relative_to(root)
                or not program.is_relative_to(root)
                or not executable.is_file()
                or not program.is_dir()
                or hashlib.sha256(executable.read_bytes()).hexdigest()
                != value["files"][engine["executable"]]
            ):
                raise ValueError("invalid native renderer")
            return cls(executable, program)
        except (OSError, ValueError, KeyError, TypeError):
            raise DomainError(
                503, "Office 原生渲染器安装不完整，请重新安装锁定依赖", "office_renderer_invalid"
            ) from None

    def arguments(self, source: Path, target: Path, profile: Path) -> list[str]:
        """参数来自服务创建的私有路径；沿用原生 helper 的有界输出协议。"""
        return [
            str(self.executable),
            "--program-directory",
            str(self.program),
            "--input-path",
            str(source),
            "--output-path",
            str(target),
            "--profile-directory",
            str(profile),
            "--max-output-bytes",
            str(40 * 1024 * 1024),
            "--max-image-resolution",
            "1600",
        ]

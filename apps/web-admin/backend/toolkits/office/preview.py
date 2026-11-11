"""受管LibreOffice渲染；独立用户配置、超时取消及PDF真实质量复核。"""

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.process import run_process
from app.modules.identity.entity.bo.models import Account
from app.workers.processes import ProcessWorkers
from toolkits.office.contracts import Artifact, InputFile, office_archive
from toolkits.office.native_renderer import NativeRenderer
from toolkits.office.quality import expected_text, inspect_pdf


class PreviewService:
    """渲染只处理授权后复制的文档，输出目录由服务创建而非模型指定。"""

    def __init__(
        self,
        root: Path,
        workers: ProcessWorkers,
        executable: str = "",
        native_manifest: Path | None = None,
    ) -> None:
        self.root, self.workers, self.executable = root.resolve(), workers, executable
        self.native_manifest = native_manifest
        self.limit = asyncio.Semaphore(2)

    def command(self) -> str:
        """优先显式部署配置，找不到渲染器时返回明确依赖诊断。"""
        return self._renderer()[0]

    def _renderer(self) -> tuple[str, NativeRenderer | None]:
        candidates = [self.executable] if self.executable else ["libreoffice", "soffice"]
        if os.name == "nt" and not self.executable:
            candidates.extend(
                [
                    str(
                        Path(os.environ.get("PROGRAMFILES", "C:/Program Files"))
                        / "LibreOffice/program/soffice.com"
                    )
                ]
            )
        for candidate in candidates:
            found = shutil.which(candidate)
            if found:
                return found, None
        if not self.executable and self.native_manifest:
            native = NativeRenderer.load(self.native_manifest)
            return str(native.executable), native
        raise DomainError(
            503,
            "Office渲染器未安装：请安装LibreOffice或配置WEB_ADMIN_OFFICE_EXECUTABLE",
            "office_renderer_unavailable",
        )

    async def _render(self, file: InputFile, directory: Path) -> Path:
        await asyncio.to_thread(office_archive, file)
        command, native = await asyncio.to_thread(self._renderer)
        suffix = Path(file.filename).suffix.lower()
        source = directory / ("document" + suffix)
        await asyncio.to_thread(source.write_bytes, file.content)
        profile = directory / "profile"
        output = directory / "rendered"
        await asyncio.to_thread(output.mkdir)
        arguments = [
            command,
            "-env:UserInstallation=" + profile.as_uri(),
            "--headless",
            "--nologo",
            "--nodefault",
            "--nofirststartwizard",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            str(output),
            str(source),
        ]
        if native:
            await asyncio.to_thread(profile.mkdir)
            arguments = native.arguments(source, output / "document.pdf", profile)
        async with self.limit:
            await run_process(
                arguments,
                directory,
                duration=120,
            )
        result = output / "document.pdf"
        if (
            not await asyncio.to_thread(result.is_file)
            or await asyncio.to_thread(lambda: result.stat().st_size) > 40 * 1024 * 1024
        ):
            raise DomainError(502, "Office渲染器未产生有效预览")
        return result

    async def preview_asset(self, account: Account, name: str, content: bytes) -> bytes:
        """资产服务完成权限检查后调用；方法不接收任意磁盘路径。"""
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="preview-", dir=self.root) as name_root:
            path = await self._render(InputFile(name, content), Path(name_root))
            return await asyncio.to_thread(path.read_bytes)

    async def assess(self, artifact: Artifact, destination: Path) -> dict[str, object]:
        """保存PDF/缩略图与成果同生命周期；失败不返回伪造通过状态。"""
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="quality-", dir=self.root) as name_root:
            rendered = await self._render(
                InputFile(artifact.filename, artifact.content), Path(name_root)
            )
            target = destination / "preview.pdf"
            await asyncio.to_thread(shutil.copyfile, rendered, target)
        return await self.workers.submit(
            inspect_pdf,
            {
                "pdfPath": str(target),
                "outputDirectory": str(destination / "pages"),
                "expectedText": artifact.metadata.get(
                    "expectedText", expected_text(artifact.structure)
                ),
                "fontFamilies": artifact.metadata.get("fontFamilies", []),
                "calculationVerified": artifact.metadata.get("calculationVerified", False),
            },
            60,
        )

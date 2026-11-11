"""扩展先完整安装和检查，再发布来源版本；失败不覆盖当前可用版本。"""

import asyncio
import hashlib
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.archive import read_archive
from app.modules.extensions.service.mcp_client import McpClient
from app.modules.extensions.service.process import (
    entrypoint,
    run_process,
    runtime_command,
    tool_environment,
)
from app.modules.extensions.service.validation import manifest_definition


@dataclass(frozen=True)
class Installation:
    """已健康检查的不可变版本目录，仅服务内部传递真实路径。"""

    manifest: dict[str, object]
    digest: str
    directory: Path


class ExtensionInstaller:
    """安装工序不占数据库事务，所有临时文件都位于平台运行目录。"""

    def __init__(
        self, root: Path, mcp: McpClient, node: str | None = None, uv: str | None = None
    ) -> None:
        self.root = root.resolve()
        self.mcp = mcp
        self.node = node or shutil.which("node") or "node"
        self.uv = uv or shutil.which("uv") or "uv"

    async def install(self, data: bytes) -> Installation:
        """ZIP展开、锁定安装、最终路径检查都成功后才写完成标记。"""
        if not data or len(data) > 16 * 1024 * 1024:
            raise DomainError(413, "扩展包大小限制为16MiB")
        files = await asyncio.to_thread(
            read_archive, data, max_files=3000, max_bytes=64 * 1024 * 1024
        )
        try:
            manifest = manifest_definition(json.loads(files["superdsh-extension.json"]))
        except (KeyError, ValueError, UnicodeError) as error:
            raise DomainError(422, "扩展缺少有效的superdsh-extension.json") from error
        checksum = hashlib.sha256(data).hexdigest()
        # 安装目录按内容摘要定址，身份/版本保存在元数据；避免长名称叠加导致
        # Windows 虚拟环境启动器内部的 pyvenv.cfg 查找超过 MAX_PATH。
        destination = self.root / checksum[:32]
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)
        if await asyncio.to_thread(destination.exists):
            try:
                record = json.loads(
                    await asyncio.to_thread(
                        (destination / ".superdsh-install.json").read_text, "utf-8"
                    )
                )
                if record["digest"] == checksum:
                    return Installation(
                        manifest_definition(record["manifest"]), checksum, destination
                    )
            except (OSError, ValueError, KeyError):
                pass
            raise DomainError(409, "该扩展版本尚未完成安装，请检查安装任务")
        stage = Path(await asyncio.to_thread(tempfile.mkdtemp, prefix=".install-", dir=self.root))
        moved = False
        try:
            await asyncio.to_thread(self._write_stage, stage, files)
            await asyncio.to_thread(entrypoint, stage, str(manifest["entrypoint"]))
            skills = manifest.get("skills", [])
            if isinstance(skills, list):
                for skill in skills:
                    if isinstance(skill, dict):
                        await asyncio.to_thread(entrypoint, stage, str(skill["entrypoint"]))
            await asyncio.to_thread(destination.parent.mkdir, parents=True, exist_ok=True)
            try:
                await asyncio.to_thread(stage.rename, destination)
            except FileExistsError as error:
                raise DomainError(409, "相同版本正在安装，请稍后重试") from error
            moved = True
            # npm 的 Windows 本地依赖使用绝对 Junction；依赖必须在最终目录创建，
            # 否则搬移后会指向已删除的暂存路径。未完成标记的目录不能参与执行。
            await self._dependencies(destination, str(manifest["runtime"]))
            await self.check(Installation(manifest, checksum, destination))
            await asyncio.to_thread(
                (destination / ".superdsh-install.json").write_text,
                json.dumps({"digest": checksum, "manifest": manifest}, ensure_ascii=False),
                "utf-8",
            )
            return Installation(manifest, checksum, destination)
        except BaseException:
            if moved:
                await self.remove(destination)
            raise
        finally:
            if await asyncio.to_thread(stage.exists):
                await self.remove(stage)

    @staticmethod
    def _write_stage(stage: Path, files: dict[str, bytes]) -> None:
        """大归档磁盘写入在线程执行，避免阻塞HTTP事件循环。"""
        for name, content in files.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(content)

    async def _dependencies(self, stage: Path, runtime: str) -> None:
        python = runtime == "python"
        declaration = stage / ("pyproject.toml" if python else "package.json")
        if not declaration.is_file():
            if python:
                raise DomainError(422, "Python扩展必须提供pyproject.toml和uv.lock")
            return
        if not (stage / ("uv.lock" if python else "package-lock.json")).is_file():
            raise DomainError(422, "扩展依赖必须提供锁文件")
        environment = {
            **tool_environment(stage),
            "UV_CACHE_DIR": str(self.root / ".runtime" / "uv-cache"),
            "UV_PYTHON_INSTALL_DIR": str(self.root / ".runtime" / "python"),
            "UV_PYTHON_INSTALL_BIN": "false",
        }
        if python:
            await run_process(
                [
                    self.uv,
                    "venv",
                    "--relocatable",
                    "--python",
                    sys.executable,
                    str(stage / ".venv"),
                ],
                stage,
                duration=180,
                environment=environment,
            )
            await run_process(
                [
                    self.uv,
                    "sync",
                    "--locked",
                    "--no-dev",
                    "--python",
                    str(
                        stage
                        / ".venv"
                        / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
                    ),
                    "--project",
                    str(stage),
                ],
                stage,
                duration=180,
                environment=environment,
            )
        else:
            executable = await asyncio.to_thread(Path(shutil.which(self.node) or self.node).resolve)
            candidates = (
                executable.parent / "node_modules/npm/bin/npm-cli.js",
                executable.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
            )
            npm = next((path for path in candidates if path.is_file()), None)
            if npm is None:
                raise DomainError(503, "Node环境缺少npm，不能准备锁定扩展依赖")
            await run_process(
                [
                    str(executable),
                    str(npm),
                    "ci",
                    "--omit=dev",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                ],
                stage,
                duration=180,
                environment=environment,
            )

    async def check(self, installation: Installation) -> None:
        """健康检查在真实最终路径运行，能发现搬移后失效的解释器。"""
        manifest, directory = installation.manifest, installation.directory
        command = runtime_command(directory, manifest, self.node)
        with tempfile.TemporaryDirectory(prefix=".check-", dir=self.root) as work:
            if manifest["runtime"] == "mcp-stdio":
                async with self.mcp.connect(command=command, directory=Path(work)) as session:
                    actual = {str(item["id"]): item for item in await self.mcp.discover(session)}
                    tools = manifest["tools"]
                    assert isinstance(tools, list)
                    for tool in tools:
                        assert isinstance(tool, dict)
                        current = actual.get(str(tool["id"]))
                        if (
                            current is None
                            or current["inputSchema"] != tool["inputSchema"]
                            or current.get("outputSchema") != tool.get("outputSchema")
                        ):
                            raise DomainError(422, "MCP工具与包清单不一致")
                        tool["remoteName"] = current["remoteName"]
            else:
                result = await run_process(command, Path(work), {"operation": "health"}, 30)
                if result.get("ok") is not True:
                    raise DomainError(422, "扩展健康检查未通过")

    async def remove(self, path: Path) -> None:
        """只清理本次安装根内的子目录，不跟随指向外部的链接。"""
        await asyncio.to_thread(self._remove, path)

    def _remove(self, path: Path) -> None:
        resolved = path.resolve()
        if resolved == self.root or not resolved.is_relative_to(self.root) or path.is_symlink():
            raise RuntimeError("扩展清理路径越界")
        shutil.rmtree(path, ignore_errors=False)

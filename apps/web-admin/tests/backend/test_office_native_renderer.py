"""可选原生渲染器清单边界与真实 Windows PPT 预览；不改变外部安装或用户文档。"""

import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.infrastructure.errors import DomainError
from app.workers.processes import ProcessWorkers
from toolkits.office.native_renderer import NativeRenderer, bundled_manifest
from toolkits.office.presentation import create_presentation
from toolkits.office.preview import PreviewService


@pytest.mark.parametrize("invalid", ["escape", "digest", "missing", "unbuilt"])
def test_native_manifest_rejects_invalid_installation(tmp_path: Path, invalid: str) -> None:
    """安装清单不能指向包外程序，损坏和缺失文件必须明确报错。"""
    executable = tmp_path / "native.exe"
    executable.write_bytes(b"synthetic executable")
    (tmp_path / "program").mkdir()
    manifest = tmp_path / "prebuilds.json"
    path = "../native.exe" if invalid == "escape" else "native.exe"
    manifest.write_text(
        json.dumps(
            {
                "status": "missing" if invalid == "unbuilt" else "built",
                "engine": {
                    "kind": "native",
                    "executable": path,
                    "programDirectory": "absent" if invalid == "missing" else "program",
                },
                "files": {
                    path: "invalid"
                    if invalid == "digest"
                    else hashlib.sha256(executable.read_bytes()).hexdigest()
                },
            }
        )
    )
    with pytest.raises(DomainError, match="安装不完整"):
        NativeRenderer.load(manifest)


def test_explicit_cli_takes_precedence_over_broken_native_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """管理员显式选择的 CLI 不因旁边的可选原生包损坏而失效。"""
    monkeypatch.setattr("toolkits.office.preview.shutil.which", lambda value: value)
    preview = PreviewService(
        tmp_path, Mock(spec=ProcessWorkers), "configured-cli", tmp_path / "absent.json"
    )
    assert preview.command() == "configured-cli"


@pytest.mark.skipif(os.name != "nt", reason="实际固定 Windows 原生依赖验证")
async def test_native_renderer_produces_real_chinese_ppt_preview() -> None:
    """实际 helper 生成 PDF 和缩略图，检查中文、页数与指定字体，而非只看文件存在。"""
    root = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    repository = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    manifest = await asyncio.to_thread(bundled_manifest, repository)
    assert manifest is not None, "锁定的 Windows 渲染器未安装"
    artifact = create_presentation(
        {
            "title": "中文预览",
            "designTheme": {"fontFace": "Microsoft YaHei"},
            "slides": [
                {
                    "id": "cover",
                    "kind": "title",
                    "title": "个人与AI协作开发",
                    "body": ["明确需求，可靠交付"],
                }
            ],
        }
    )
    with tempfile.TemporaryDirectory(prefix="native-office-", dir=root) as temporary:
        directory = Path(temporary)
        workers = ProcessWorkers(directory / "workers")
        preview = PreviewService(directory / "renderer", workers, native_manifest=manifest)
        try:
            report = await preview.assess(artifact, directory)
            assert report["status"] == "passed", report["issues"]
            assert report["pageCount"] == 1 and report["textPreserved"] is True
            assert (directory / "preview.pdf").read_bytes().startswith(b"%PDF")
        finally:
            await workers.close()

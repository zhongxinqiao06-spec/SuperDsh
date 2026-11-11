"""由独立渲染命令显式执行的真实Office验证，不使用模拟PDF。"""

import asyncio
import io
import os
import tempfile
from dataclasses import replace
from pathlib import Path

import pytest
from openpyxl import load_workbook

from app.workers.processes import ProcessWorkers
from toolkits.office.document import create_document
from toolkits.office.presentation import create_presentation
from toolkits.office.preview import PreviewService
from toolkits.office.spreadsheet import create_workbook


@pytest.mark.office_renderer
async def test_small_workbook_provenance_prints_all_text_within_original_page_count() -> None:
    """生产最小表格反例：不能靠缩列/字体掩盖越界并裁去方案或计算口径尾句。"""
    root = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    if ".superdsh-work" not in root.parts or "web-admin-validation" not in root.parts:
        raise RuntimeError("渲染测试必须使用隔离验证目录")
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    artifact = create_workbook(
        {
            "title": "生产表格验证",
            "sheets": [
                {
                    "name": "中文数据",
                    "source": {"columns": ["项目", "金额"], "rows": [["合成数据", 12.5]]},
                }
            ],
        },
        [],
    )
    workbook = load_workbook(io.BytesIO(artifact.content))
    expected = [
        str(cell.value) for row in workbook["来源与异常"] for cell in row if cell.value is not None
    ]
    workbook.close()
    artifact = replace(artifact, metadata={**artifact.metadata, "expectedText": expected})
    with tempfile.TemporaryDirectory(prefix="office-small-workbook-", dir=root) as temporary:
        output = Path(temporary)
        workers = ProcessWorkers(output / "workers")
        renderer = PreviewService(
            output / "renderer", workers, os.environ["WEB_ADMIN_OFFICE_EXECUTABLE"]
        )
        try:
            result = await renderer.assess(artifact, output)
            assert result["status"] == "passed", result["issues"]
            assert result["textPreserved"] is True
            assert result["pageCount"] == 3  # 同方案旧成果也是3页，但其第3页存在可见文字越界。
            assert result["issues"] == []
        finally:
            await workers.close()


@pytest.mark.office_renderer
async def test_real_office_rendering_preserves_chinese_text_and_editable_sources() -> None:
    """三类文件均经原生渲染，验证PDF正文、页边界和真实PNG缩略图。"""
    root = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    if ".superdsh-work" not in root.parts or "web-admin-validation" not in root.parts:
        raise RuntimeError("渲染测试必须使用隔离验证目录")
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="office-render-", dir=root) as temporary:
        work = Path(temporary)
        workers = ProcessWorkers(work / "workers")
        renderer = PreviewService(
            work / "renderer", workers, os.environ["WEB_ADMIN_OFFICE_EXECUTABLE"]
        )
        try:
            artifacts = [
                create_document(
                    {
                        "title": "中文渲染验证",
                        "tableOfContents": False,
                        "sections": [
                            {
                                "id": "section",
                                "title": "真实正文",
                                "blocks": [
                                    {
                                        "type": "paragraph",
                                        "text": "这是独立生成的可编辑文档，用于验证实际渲染。",
                                    }
                                ],
                            }
                        ],
                    }
                ),
                create_presentation(
                    {
                        "title": "原生演示",
                        "slides": [
                            {
                                "id": "slide",
                                "kind": "content",
                                "title": "中文演示验证",
                                "body": ["真实文字经过原生渲染", "图表和正文保留编辑能力"],
                            }
                        ],
                    }
                ),
                create_workbook(
                    {
                        "title": "计算验证",
                        "sheets": [
                            {
                                "name": "数据",
                                "source": {
                                    "columns": ["项目", "金额"],
                                    "rows": [["测试", 12.5], ["样例", 6.5]],
                                },
                                "operations": [
                                    {
                                        "type": "formula",
                                        "column": "合计",
                                        "expression": {"aggregate": "sum", "column": "金额"},
                                    }
                                ],
                            }
                        ],
                    },
                    [],
                ),
            ]
            for index, artifact in enumerate(artifacts):
                destination = work / str(index)
                destination.mkdir()
                result = await renderer.assess(artifact, destination)
                assert result["status"] == "passed", (
                    artifact.filename,
                    result["issues"],
                    result["fonts"],
                )
                assert result["rendered"] is True
                assert result["textPreserved"] is True
                assert (destination / "preview.pdf").read_bytes().startswith(b"%PDF-")
                assert (destination / "pages/page-1.png").read_bytes().startswith(b"\x89PNG")
            missing_font = create_document(
                {
                    "title": "字体替代反例",
                    "brand": {"fontFace": "Synthetic Missing Family"},
                    "tableOfContents": False,
                    "sections": [
                        {
                            "id": "text",
                            "title": "反例",
                            "blocks": [{"type": "paragraph", "text": "字体缺失必须返回草稿状态"}],
                        }
                    ],
                }
            )
            negative = work / "missing-font"
            negative.mkdir()
            rejected = await renderer.assess(missing_font, negative)
            assert rejected["status"] == "draft"
            missing_fonts = rejected["missingFonts"]
            assert isinstance(missing_fonts, list) and "Synthetic Missing Family" in missing_fonts
        finally:
            await workers.close()

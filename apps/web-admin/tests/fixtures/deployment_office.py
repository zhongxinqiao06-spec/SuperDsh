"""生产镜像内以脚本参数执行的渲染验证；不复制测试源码到镜像或业务目录。"""

import asyncio
import tempfile
from pathlib import Path

from app.workers.processes import ProcessWorkers
from toolkits.office.document import create_document
from toolkits.office.presentation import create_presentation
from toolkits.office.preview import PreviewService
from toolkits.office.spreadsheet import create_workbook


async def validate() -> None:
    """真实 LibreOffice 渲染三类源文件，检查中文、字体、PDF 和缩略图。"""
    root = Path("/data/runtime/.superdsh-work/web-admin-validation")
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="deployment-office-", dir=root) as temporary:
        directory = Path(temporary)
        workers = ProcessWorkers(directory / "workers")
        renderer = PreviewService(directory / "renderer", workers, "/usr/bin/libreoffice")
        artifacts = [
            create_document(
                {
                    "title": "生产部署中文验证",
                    "tableOfContents": False,
                    "sections": [
                        {
                            "id": "body",
                            "title": "正文",
                            "blocks": [
                                {
                                    "type": "paragraph",
                                    "text": "真实中文字体和文件内容。",
                                }
                            ],
                        }
                    ],
                }
            ),
            create_presentation(
                {
                    "title": "生产演示验证",
                    "slides": [
                        {
                            "id": "slide",
                            "kind": "content",
                            "title": "简体中文字体",
                            "body": ["真实演示经过原生渲染"],
                        }
                    ],
                }
            ),
            create_workbook(
                {
                    "title": "生产表格验证",
                    "sheets": [
                        {
                            "name": "中文数据",
                            "source": {
                                "columns": ["项目", "金额"],
                                "rows": [["合成数据", 12.5]],
                            },
                        }
                    ],
                },
                [],
            ),
        ]
        try:
            for index, artifact in enumerate(artifacts):
                destination = directory / str(index)
                destination.mkdir()
                result = await renderer.assess(artifact, destination)
                assert result["status"] == "passed", (
                    artifact.filename,
                    result["issues"],
                    result["fonts"],
                )
                assert result["textPreserved"] is True
                assert (destination / "preview.pdf").read_bytes().startswith(b"%PDF-")
                assert (destination / "pages/page-1.png").read_bytes().startswith(b"\x89PNG")
        finally:
            await workers.close()


asyncio.run(validate())

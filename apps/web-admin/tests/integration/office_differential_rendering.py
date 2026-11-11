"""同一 LibreOffice 渲染旧新合成成果，保存分页、正文、图表与逐页像素差异证据。"""

import asyncio
import hashlib
import json
import os
from pathlib import Path

import pytest
from PIL import Image, ImageChops, ImageStat
from pypdf import PdfReader

from app.workers.processes import ProcessWorkers
from toolkits.office.contracts import Artifact
from toolkits.office.preview import PreviewService
from toolkits.office.quality import normalized

EXPECTED = {
    "docx": [
        "差分文档核对",
        "内容与来源",
        "原生可编辑段落",
        "应在五个工作日内提交",
        "第一项",
        "第二项",
        "项目",
        "金额",
        "200",
        "合成制度.txt",
    ],
    "xlsx": ["项目", "数量", "单价", "金额", "金额对比", "合计", "20", "24"],
    "pptx": ["差分演示核对", "可编辑成果", "原生表格", "原生图表", "金额", "20", "24"],
}


def pdf_text(path: Path) -> str:
    """独立提取 PDF 正文，与 PDFium 质量检查交叉核验实际可见文字。"""
    return "\n".join(pdf_pages(path))


def pdf_pages(path: Path) -> list[str]:
    """保留页边界，用于目录等必须出现在指定页的交互内容检查。"""
    return [page.extract_text() for page in PdfReader(path).pages]


def chart_pixels(path: Path, kind: str) -> dict[str, object]:
    """检测固定合成图表的绘图区着色面积，结合图表文字判断原生图表确实可见。"""
    with Image.open(path) as source:
        image = source.convert("RGB")
    width, height = image.size
    # 排除标题、页眉与数据表表头；仅对两份已知方案的绘图区采样。
    region = (0.12, 0.18, 0.88, 0.72) if kind == "xlsx" else (0.15, 0.30, 0.90, 0.80)
    image = image.crop(
        (
            int(width * region[0]),
            int(height * region[1]),
            int(width * region[2]),
            int(height * region[3]),
        )
    )
    image.thumbnail((500, 500))
    colors = image.getcolors(image.width * image.height) or []
    colored = sum(
        count
        for count, pixel in colors
        if isinstance(pixel, tuple)
        and max(pixel[:3]) - min(pixel[:3]) > 35
        and min(pixel[:3]) < 210
    )
    ratio = colored / (image.width * image.height)
    return {
        "region": list(region),
        "coloredPixels": colored,
        "coloredPixelRatio": ratio,
        "visible": colored > 200 and ratio > 0.002,
        "scope": "固定方案绘图区像素和PDF图表文字；不是通用图表内容识别",
    }


def compare_pages(old: Path, new: Path, destination: Path) -> list[dict[str, object]]:
    """保留逐页并排图和真实像素差；不把语义通过伪装成像素完全相同。"""
    old_pages = sorted(old.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    new_pages = sorted(new.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    differences: list[dict[str, object]] = []
    destination.mkdir(parents=True, exist_ok=True)
    for index in range(max(len(old_pages), len(new_pages))):
        prior = Image.open(old_pages[index]).convert("RGB") if index < len(old_pages) else None
        current = Image.open(new_pages[index]).convert("RGB") if index < len(new_pages) else None
        images = [value for value in [prior, current] if value is not None]
        width, height = max(value.width for value in images), max(value.height for value in images)
        left, right = (
            Image.new("RGB", (width, height), "white"),
            Image.new("RGB", (width, height), "white"),
        )
        if prior:
            left.paste(prior, (0, 0))
        if current:
            right.paste(current, (0, 0))
        difference = ImageChops.difference(left, right)
        statistics = ImageStat.Stat(difference)
        grayscale = difference.convert("L")
        different_pixels = sum(grayscale.histogram()[8:])
        combined = Image.new("RGB", (width * 2 + 16, height), "#999999")
        combined.paste(left, (0, 0))
        combined.paste(right, (width + 16, 0))
        name = f"page-{index + 1}.png"
        combined.save(destination / name)
        difference.save(destination / f"difference-{name}")
        differences.append(
            {
                "page": index + 1,
                "oldSize": list(prior.size) if prior else None,
                "newSize": list(current.size) if current else None,
                "meanAbsoluteDifference": sum(statistics.mean) / 3 / 255,
                "differentPixelRatio": different_pixels / (width * height),
                "exactMatch": prior is not None
                and current is not None
                and difference.getbbox() is None,
                "comparison": str(destination.name + "/" + name),
            }
        )
    return differences


@pytest.mark.office_renderer
@pytest.mark.parametrize("kind", ["docx", "xlsx", "pptx"])
async def test_old_and_new_office_outputs_render_in_the_same_environment(kind: str) -> None:
    """只读输入来自真实旧新生成器；所有 PDF/PNG/报告保留于独立本轮验证目录。"""
    configured = os.environ.get("WEB_ADMIN_OFFICE_PARITY_INPUT")
    if not configured:
        pytest.skip("本轮未提供旧新成对成果，不能宣称旧新渲染验证通过")
    source = await asyncio.to_thread(Path(configured).resolve)
    root = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    if ".superdsh-work" not in root.parts or "web-admin-validation" not in root.parts:
        raise RuntimeError("成对渲染必须使用隔离验证目录")
    output = root / "office-paired-rendering" / kind
    await asyncio.to_thread(output.mkdir, parents=True, exist_ok=True)
    workers = ProcessWorkers(output / "workers")
    renderer = PreviewService(
        output / "renderer", workers, os.environ["WEB_ADMIN_OFFICE_EXECUTABLE"]
    )
    reports: dict[str, dict[str, object]] = {}
    failures: list[str] = []
    try:
        for version in ("old", "new"):
            filename = source / f"{version}.{kind}"
            content = await asyncio.to_thread(filename.read_bytes)
            digest = hashlib.sha256(content).hexdigest()
            destination = output / version
            await asyncio.to_thread(destination.mkdir, parents=True, exist_ok=True)
            artifact = Artifact(
                filename.name,
                content,
                "application/octet-stream",
                {},
                {"expectedText": EXPECTED[kind]},
            )
            report = await renderer.assess(artifact, destination)
            text = await asyncio.to_thread(pdf_text, destination / "preview.pdf")
            await asyncio.to_thread(
                (destination / "content.txt").write_text, text, encoding="utf-8"
            )
            report["inputSha256"] = digest
            report["expectedText"] = EXPECTED[kind]
            required_text = {
                value: normalized(value) in normalized(text) for value in EXPECTED[kind]
            }
            report["requiredTextFound"] = required_text
            if kind == "docx":
                # 正文其它页有章节标题，不能代替目录页具备真实可用的目录条目。
                pages = await asyncio.to_thread(pdf_pages, destination / "preview.pdf")
                directory = normalized(pages[1]) if len(pages) > 1 else ""
                entries = {
                    label: normalized(label) in directory for label in ("内容与来源", "资料来源")
                }
                report["directoryPageEntries"] = entries
                if not all(entries.values()):
                    failures.append(f"{version}.{kind}: 第二页目录未包含实际章节条目")
            if report["status"] != "passed":
                failures.append(f"{version}.{kind}: 渲染质量存在问题 {report['issues']}")
            if not all(required_text.values()):
                failures.append(f"{version}.{kind}: PDF正文缺少方案内容")
            if kind in {"xlsx", "pptx"}:
                page = 1 if kind == "xlsx" else 3
                visible = await asyncio.to_thread(
                    chart_pixels, destination / f"pages/page-{page}.png", kind
                )
                report["chartVisibility"] = visible
                if visible["visible"] is not True:
                    failures.append(f"{version}.{kind}: 图表绘图区未发现足够图形像素")
            if hashlib.sha256(await asyncio.to_thread(filename.read_bytes)).hexdigest() != digest:
                failures.append(f"{version}.{kind}: 输入文件被修改")
            reports[version] = report
            await asyncio.to_thread(
                (destination / "quality.json").write_text,
                json.dumps(report, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        same_pages = reports["old"]["pageCount"] == reports["new"]["pageCount"]
        if not same_pages:
            failures.append(
                f"{kind}: 旧新页数不同 {reports['old']['pageCount']} / {reports['new']['pageCount']}"
            )
        differences = await asyncio.to_thread(
            compare_pages, output / "old/pages", output / "new/pages", output / "comparison"
        )
        summary = {
            "renderer": "LibreOffice",
            "scope": "同方案旧Node/新Python真实产物；合成数据；不代表Microsoft Office或安卓原生客户端",
            "samePageCount": same_pages,
            "semanticRenderingPassed": not failures,
            "pixelIdentical": all(page["exactMatch"] for page in differences),
            "visualReviewRequired": any(not page["exactMatch"] for page in differences),
            "officeClientReviewed": False,
            "files": reports,
            "pages": differences,
            "failures": failures,
        }
        await asyncio.to_thread(
            (output / "comparison.json").write_text,
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        assert not failures, "\n".join(failures)
    finally:
        await workers.close()

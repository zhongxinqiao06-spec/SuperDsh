"""旧 Node 与新 Python 生成器同方案比较原生结构、公式缓存和来源语义。"""

import base64
import io
import json
import os
import subprocess
import zipfile
from pathlib import Path
from typing import cast
from xml.etree import ElementTree

from docx import Document
from openpyxl import load_workbook
from pptx import Presentation

from toolkits.office.document import create_document
from toolkits.office.formula_import import FormulaWorkbook
from toolkits.office.presentation import create_presentation
from toolkits.office.spreadsheet import create_workbook

ROOT = Path(__file__).resolve().parents[4]
OUTPUT = (
    Path(
        os.environ.get(
            "WEB_ADMIN_VALIDATION_DIR",
            str(ROOT / ".superdsh-work/web-admin-validation/phase-three-runtime"),
        )
    ).resolve()
    / "office-semantic"
)


def legacy(fixtures: list[dict[str, object]]) -> list[dict[str, object]]:
    process = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/office-oracle.ts")],
        input=json.dumps(fixtures),
        encoding="utf-8",
        capture_output=True,
        cwd=ROOT,
        timeout=60,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    return cast(list[dict[str, object]], json.loads(process.stdout))


def paired(
    kind: str,
    plan: dict[str, object],
    current: bytes,
    sources: list[dict[str, object]] | None = None,
) -> tuple[bytes, bytes]:
    prior = legacy([{"kind": kind, "plan": plan, "sources": sources or []}])[0]
    assert prior["valid"] is True, prior
    old = base64.b64decode(str(prior["contentBase64"]))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / f"old.{kind}").write_bytes(old)
    (OUTPUT / f"new.{kind}").write_bytes(current)
    return old, current


def test_workbook_values_formulas_cache_charts_and_output_references_match() -> None:
    plan: dict[str, object] = {
        "title": "差分数值核对",
        "sheets": [
            {
                "name": "明细",
                "source": {
                    "columns": ["项目", "数量", "单价"],
                    "rows": [["A", 2, 10], ["B", 3, 8]],
                },
                "operations": [
                    {
                        "type": "formula",
                        "column": "金额",
                        "expression": {
                            "op": "*",
                            "left": {"column": "数量"},
                            "right": {"column": "单价"},
                        },
                    }
                ],
                "charts": [
                    {"type": "column", "title": "金额对比", "category": "项目", "values": ["金额"]}
                ],
            },
            {
                "name": "汇总",
                "source": "output:明细",
                "operations": [
                    {
                        "type": "group",
                        "by": ["项目"],
                        "aggregates": [{"column": "金额", "as": "合计", "operation": "sum"}],
                    }
                ],
            },
        ],
    }
    current = create_workbook(plan, []).content
    values: list[dict[str, object]] = []
    for content in paired("xlsx", plan, current):
        workbook = load_workbook(io.BytesIO(content), data_only=False)
        cached = load_workbook(io.BytesIO(content), data_only=True)
        recalculation = FormulaWorkbook(workbook)
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            charts = sum(
                name.startswith("xl/charts/chart") and name.endswith(".xml")
                for name in archive.namelist()
            )
        values.append(
            {
                "detail": list(cached["明细"].values),
                "summary": list(cached["汇总"].values),
                "formulaCount": sum(
                    cell.data_type == "f" for row in workbook["明细"] for cell in row
                ),
                "calculated": [recalculation.cell("明细", cell) for cell in ["D2", "D3"]],
                "charts": charts,
                "provenance": list(cached["来源与异常"].values),
                "orientation": workbook["明细"].page_setup.orientation,
                "columnWidth": workbook["明细"].column_dimensions["A"].width,
                "headerHeight": workbook["明细"].row_dimensions[1].height,
                "rowHeight": workbook["明细"].row_dimensions[2].height,
            }
        )
        workbook.close()
        cached.close()
    assert values[0] == values[1]
    assert values[0]["calculated"] == [20, 24]
    assert values[0]["formulaCount"] == 2 and values[0]["charts"] == 1


def test_workbook_fraction_precision_matches_confirmed_calculation_contract() -> None:
    """循环小数和负数舍入对照旧实际公式实现，不能让成果计算口径与数值不符。"""
    plan: dict[str, object] = {
        "title": "合成精度差分",
        "sheets": [
            {
                "name": "精度",
                "source": {"columns": ["输入"], "rows": [[1], [-1], [2]]},
                "operations": [
                    {
                        "type": "formula",
                        "column": "三分之一",
                        "expression": {
                            "op": "/",
                            "left": {"column": "输入"},
                            "right": {"literal": 3},
                        },
                    }
                ],
            }
        ],
    }
    prior = legacy([{"kind": "xlsx", "plan": plan, "sources": []}])[0]
    assert prior["valid"] is True
    old = load_workbook(io.BytesIO(base64.b64decode(str(prior["contentBase64"]))), data_only=True)
    new = load_workbook(io.BytesIO(create_workbook(plan, []).content), data_only=True)
    try:
        assert list(old["精度"].values) == list(new["精度"].values)
        assert new["精度"]["B2"].value == 0.333333333333
        assert new["精度"]["B3"].value == -0.333333333333
    finally:
        old.close()
        new.close()


def test_document_native_text_table_toc_and_citation_match() -> None:
    quote = "应在五个工作日内提交"
    sources: list[dict[str, object]] = [{"id": "policy", "filename": "合成制度.txt", "text": quote}]
    plan: dict[str, object] = {
        "title": "差分文档核对",
        "tableOfContents": True,
        "brand": {"company": "合成测试", "accentColor": "214D66"},
        "sections": [
            {
                "id": "section-one",
                "title": "内容与来源",
                "blocks": [
                    {"type": "paragraph", "text": "原生可编辑段落"},
                    {"type": "table", "columns": ["项目", "金额"], "rows": [["测试", "200"]]},
                    {"type": "quote", "text": quote, "sourceId": "policy"},
                    {"type": "list", "items": ["第一项", "第二项"], "ordered": True},
                ],
            }
        ],
    }
    current = create_document(plan, sources={"policy": sources[0]}).content
    signatures: list[dict[str, object]] = []
    for content in paired("docx", plan, current, sources):
        document = Document(io.BytesIO(content))
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            root = ElementTree.fromstring(archive.read("word/document.xml"))
            fields = [
                node.text or ""
                for node in root.iter(
                    "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}instrText"
                )
            ]
            namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            contents = root.findall(".//w:sdt", namespace)
            cached_entries = [
                "".join(node.text or "" for node in link.findall(".//w:t", namespace))
                for control in contents
                for link in control.findall(".//w:hyperlink", namespace)
            ]
            bookmark_names = {
                element.get("{" + namespace["w"] + "}name")
                for element in root.findall(".//w:bookmarkStart", namespace)
            }
            anchors = [
                link.get("{" + namespace["w"] + "}anchor")
                for control in contents
                for link in control.findall(".//w:hyperlink", namespace)
            ]
            assert all(anchor in bookmark_names for anchor in anchors)
            footer_fields = [
                node.text or ""
                for name in archive.namelist()
                if name.startswith("word/footer") and name.endswith(".xml")
                for node in ElementTree.fromstring(archive.read(name)).findall(
                    ".//w:instrText", namespace
                )
            ]
        signatures.append(
            {
                "authoredText": [
                    entry in text
                    for entry in [
                        "差分文档核对",
                        "内容与来源",
                        "原生可编辑段落",
                        quote,
                        "第一项",
                        "第二项",
                        "合成制度.txt",
                    ]
                ],
                "table": [
                    [[cell.text for cell in row.cells] for row in table.rows]
                    for table in document.tables
                ],
                "editableToc": any("TOC" in field for field in fields),
                "cachedDirectory": cached_entries,
                "pageFields": all(
                    any(field.strip() == expected for field in footer_fields)
                    for expected in ("PAGE", "NUMPAGES")
                ),
            }
        )
    assert signatures[0] == signatures[1]
    assert all(cast(list[bool], signatures[0]["authoredText"]))
    assert signatures[0]["editableToc"] is True
    assert signatures[0]["cachedDirectory"] == ["内容与来源", "资料来源"]
    assert signatures[0]["pageFields"] is True


def test_presentation_native_slides_tables_charts_notes_match() -> None:
    plan: dict[str, object] = {
        "title": "差分演示核对",
        "slides": [
            {"id": "title", "kind": "title", "title": "差分演示核对", "body": ["可编辑成果"]},
            {
                "id": "table",
                "kind": "table",
                "title": "原生表格",
                "table": {"columns": ["项目", "金额"], "rows": [["A", 20], ["B", 24]]},
            },
            {
                "id": "chart",
                "kind": "chart",
                "title": "原生图表",
                "notes": "合成核对说明",
                "chart": {
                    "type": "bar",
                    "categories": ["A", "B"],
                    "series": [{"name": "金额", "values": [20, 24]}],
                },
            },
        ],
    }
    current = create_presentation(plan).content
    signatures: list[dict[str, object]] = []
    for content in paired("pptx", plan, current):
        presentation = Presentation(io.BytesIO(content))
        slides = []
        for slide in presentation.slides:
            texts = [shape.text for shape in slide.shapes if shape.has_text_frame]
            title_shape = next(
                shape
                for shape in slide.shapes
                if shape.has_text_frame and shape.text in ["差分演示核对", "原生表格", "原生图表"]
            )
            slides.append(
                {
                    "title": next(
                        value
                        for value in ["差分演示核对", "原生表格", "原生图表"]
                        if value in texts
                    ),
                    "tables": [
                        [[cell.text for cell in row.cells] for row in shape.table.rows]
                        for shape in slide.shapes
                        if shape.has_table
                    ],
                    "series": [
                        [list(series.values) for series in shape.chart.series]
                        for shape in slide.shapes
                        if shape.has_chart
                    ],
                    "titleRegion": [
                        round(value.inches, 4)
                        for value in (
                            title_shape.left,
                            title_shape.top,
                            title_shape.width,
                            title_shape.height,
                        )
                    ],
                    "footer": [value for value in texts if value == "SUPERDSH" or " / " in value],
                    "tableAnchors": [
                        [str(cell.vertical_anchor) for cell in row.cells]
                        for shape in slide.shapes
                        if shape.has_table
                        for row in shape.table.rows
                    ],
                }
            )
        signatures.append(
            {
                "slides": slides,
                "notes": "合成核对说明" in presentation.slides[2].notes_slide.notes_text_frame.text,
            }
        )
    assert signatures[0] == signatures[1]
    assert signatures[0]["notes"] is True

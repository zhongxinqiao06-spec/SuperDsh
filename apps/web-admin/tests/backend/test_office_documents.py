"""真实Office文件回读与公式独立重算；所有数据为内存合成。"""

import io
import zipfile
from xml.etree import ElementTree

import pytest
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from openpyxl import Workbook, load_workbook
from pptx import Presentation

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import InputFile, office_archive
from toolkits.office.document import create_document
from toolkits.office.document_plan import inspect_document
from toolkits.office.formula_import import FormulaWorkbook
from toolkits.office.presentation import create_presentation
from toolkits.office.presentation_template import inspect_template
from toolkits.office.spreadsheet import create_workbook
from toolkits.office.spreadsheet_input import read_tables


def test_office_archive_rejects_active_embedded_workbook_and_xml_entities() -> None:
    """文档关系和图表嵌入包都检查，不能借内层工作簿夹带宏或DTD。"""
    workbook = io.BytesIO()
    with zipfile.ZipFile(workbook, "w") as archive:
        archive.writestr("xl/workbook.xml", "<workbook/>")
        archive.writestr("xl/vbaProject.bin", b"synthetic-active-content")
    presentation = io.BytesIO()
    with zipfile.ZipFile(presentation, "w") as archive:
        archive.writestr("ppt/presentation.xml", "<presentation/>")
        archive.writestr("ppt/embeddings/Chart.xlsx", workbook.getvalue())
    with pytest.raises(DomainError) as embedded:
        office_archive(InputFile("unsafe.pptx", presentation.getvalue()))
    assert embedded.value.status == 422
    invalid = io.BytesIO()
    with zipfile.ZipFile(invalid, "w") as archive:
        archive.writestr("word/document.xml", '<!DOCTYPE x [<!ENTITY a "fixture">]><x>&a;</x>')
    with pytest.raises(DomainError) as entity:
        office_archive(InputFile("unsafe.docx", invalid.getvalue()))
    assert entity.value.status == 422


def test_native_conditional_distinct_escapes_identifiers_and_recalculates() -> None:
    """条件去重计算保留可编辑公式，星号/问号作为订单字符而非通配符。"""
    artifact = create_workbook(
        {
            "title": "条件统计",
            "sheets": [
                {
                    "name": "明细",
                    "source": {
                        "columns": ["订单", "地区"],
                        "rows": [
                            ["A*", "华东"],
                            ["A*", "华东"],
                            ["A?", "华东"],
                            ["AB", "华南"],
                            ["", "华东"],
                        ],
                    },
                    "operations": [
                        {
                            "type": "formula",
                            "column": "订单数",
                            "expression": {
                                "aggregate": "countDistinct",
                                "column": "订单",
                                "where": {"column": "地区", "operator": "eq", "value": "华东"},
                            },
                        }
                    ],
                }
            ],
        },
        [],
    )
    cached = load_workbook(io.BytesIO(artifact.content), data_only=True)
    assert cached["明细"]["C2"].value == 2
    formulas = load_workbook(io.BytesIO(artifact.content), data_only=False)
    assert "COUNTIFS" in formulas["明细"]["C2"].value
    assert FormulaWorkbook(formulas).cell("明细", "C2") == 2
    cached.close()
    formulas.close()


def test_editable_document_has_table_citation_and_template_header() -> None:
    """模板页眉保留，正文表格与核对后的引用在实际DOCX中。"""
    template = Document()
    template.sections[0].header.paragraphs[0].text = "测试品牌页眉"
    template.add_paragraph("旧正文")
    data = io.BytesIO()
    template.save(data)
    plan = {
        "title": "测试文档",
        "sections": [
            {
                "id": "first",
                "title": "说明",
                "blocks": [
                    {"type": "paragraph", "text": "保留可编辑内容"},
                    {"type": "table", "columns": ["项目", "金额"], "rows": [["测试", "200"]]},
                    {"type": "quote", "text": "应在五个工作日内提交", "sourceId": "policy"},
                ],
            }
        ],
    }
    artifact = create_document(
        plan,
        InputFile("模板.docx", data.getvalue()),
        sources={"policy": {"text": "员工应在五个工作日内提交报销。", "filename": "制度"}},
    )
    document = Document(io.BytesIO(artifact.content))
    assert document.sections[0].header.paragraphs[0].text == "测试品牌页眉"
    assert document.tables[0].cell(1, 1).text == "200"
    assert "旧正文" not in "\n".join(paragraph.text for paragraph in document.paragraphs)
    assert any("[1]" in paragraph.text for paragraph in document.paragraphs)
    with pytest.raises(DomainError, match="引用"):
        create_document(plan, sources={"policy": {"text": "另一段原文"}})


def test_spreadsheet_formulas_cached_results_chart_and_source_sheet() -> None:
    """生成文件同时保留公式、真实缓存、图表和来源；前导等号文本不执行。"""
    source = InputFile("金额.csv", "项目,单价,数量\n甲,12.5,2\n乙,3.2,3\n".encode())
    plan = {
        "title": "计算表",
        "sheets": [
            {
                "name": "明细",
                "source": "0:CSV",
                "operations": [
                    {"type": "convert", "column": "单价", "to": "number"},
                    {"type": "convert", "column": "数量", "to": "number"},
                    {
                        "type": "formula",
                        "column": "金额",
                        "expression": {
                            "fn": "ROUND",
                            "args": [
                                {
                                    "op": "*",
                                    "left": {"column": "单价"},
                                    "right": {"column": "数量"},
                                },
                                {"literal": 2},
                            ],
                        },
                    },
                ],
                "charts": [
                    {"type": "column", "title": "金额", "category": "项目", "values": ["金额"]}
                ],
            },
            {"name": "文本", "source": {"columns": ["内容"], "rows": [["=1+1"]]}},
        ],
    }
    artifact = create_workbook(plan, [source])
    formulas = load_workbook(io.BytesIO(artifact.content), data_only=False)
    cached = load_workbook(io.BytesIO(artifact.content), data_only=True)
    assert formulas["明细"]["D2"].value == "=ROUND((B2*C2),2)"
    assert cached["明细"]["D2"].value == 25
    assert cached["明细"]["D3"].value == 9.6
    assert formulas["文本"]["A2"].data_type == "s"
    assert FormulaWorkbook(formulas).cell("明细", "D3") == 9.6
    assert "来源与异常" in formulas.sheetnames
    with zipfile.ZipFile(io.BytesIO(artifact.content)) as archive:
        assert "xl/charts/chart1.xml" in archive.namelist()


def test_spreadsheet_input_formulas_recomputed_and_cycles_rejected() -> None:
    """读取输入不信任旧缓存，循环公式明确失败。"""
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.worksheets[0]
    sheet.append(["字段", "数值"])
    sheet.append(["数值", 3])
    sheet.append(["公式", "=B2*2"])
    output = io.BytesIO()
    book.save(output)
    tables, _ = read_tables([InputFile("输入.xlsx", output.getvalue())])
    assert next(iter(tables.values())).rows[1][1] == 6
    sheet["B2"] = "=B3"
    output = io.BytesIO()
    book.save(output)
    with pytest.raises(DomainError, match="循环"):
        read_tables([InputFile("输入.xlsx", output.getvalue())])


def test_spreadsheet_template_formulas_recalculated_and_cached_across_hidden_sheets() -> None:
    """模板的过期缓存必须重算；隐藏页依赖及生成页公式同时保留可读缓存。"""
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = "模板"
    sheet["A1"], sheet["A2"], sheet["A3"] = 2, 3, "=SUM(A1:A2)"
    hidden = workbook.create_sheet("隐藏")
    hidden.sheet_state = "hidden"
    hidden["A1"] = "='模板'!A3*2"
    sheet["B1"], sheet["C1"] = "='隐藏'!A1+1", '=IF(A3=5,"核对成功","错误")'
    sheet["D1"] = "=A3=5"
    data = io.BytesIO()
    workbook.save(data)
    workbook.close()
    # 用测试侧归档编辑注入错误旧缓存，避免通过生产缓存写入方法自证正确。
    stale = io.BytesIO()
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with (
        zipfile.ZipFile(io.BytesIO(data.getvalue())) as original,
        zipfile.ZipFile(stale, "w") as target,
    ):
        for name in original.namelist():
            content = original.read(name)
            if name == "xl/worksheets/sheet1.xml":
                xml = ElementTree.fromstring(content)
                cell = xml.find(f".//{namespace}c[@r='A3']/{namespace}v")
                assert cell is not None
                cell.text = "999"
                content = ElementTree.tostring(xml)
            target.writestr(name, content)
    prior = load_workbook(io.BytesIO(stale.getvalue()), data_only=True)
    assert prior["模板"]["A3"].value == 999
    prior.close()
    artifact = create_workbook(
        {
            "title": "重算模板",
            "sheets": [
                {
                    "name": "结果",
                    "source": {"columns": ["数量"], "rows": [[4]]},
                    "operations": [
                        {
                            "type": "formula",
                            "column": "倍数",
                            "expression": {
                                "op": "*",
                                "left": {"column": "数量"},
                                "right": {"literal": 2},
                            },
                        }
                    ],
                }
            ],
        },
        [],
        InputFile("模板.xlsx", stale.getvalue()),
    )
    cached = load_workbook(io.BytesIO(artifact.content), data_only=True)
    formulas = load_workbook(io.BytesIO(artifact.content), data_only=False)
    try:
        assert cached["模板"]["A3"].value == 5
        assert cached["隐藏"]["A1"].value == 10
        assert cached["模板"]["B1"].value == 11
        assert cached["模板"]["C1"].value == "核对成功"
        assert cached["模板"]["D1"].value is True
        assert cached["结果"]["B2"].value == 8
        assert formulas["模板"]["A3"].value == "=SUM(A1:A2)"
        assert formulas["隐藏"].sheet_state == "hidden"
        assert formulas["结果"]["B2"].data_type == "f"
        assert artifact.structure["formulaCount"] == 6
        assert artifact.metadata["calculationVerified"] is True
    finally:
        cached.close()
        formulas.close()


@pytest.mark.parametrize("formula", ["=A1", "=UNSUPPORTED(1)", "=1/0", "#VALUE!"])
def test_spreadsheet_template_invalid_calculation_never_publishes_verified_artifact(
    formula: str,
) -> None:
    """模板循环、未知函数、错误值不依赖新增Sheet是否引用它们，必须先失败。"""
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet["A1"] = formula
    data = io.BytesIO()
    workbook.save(data)
    workbook.close()
    with pytest.raises(DomainError) as error:
        create_workbook(
            {
                "title": "错误模板",
                "sheets": [{"name": "结果", "source": {"columns": ["数量"], "rows": [[1]]}}],
            },
            [],
            InputFile("模板.xlsx", data.getvalue()),
        )
    assert error.value.status == 422


def _field_template(instruction: str, simple: bool, split: bool = False) -> InputFile:
    """合成页眉域，不引用真实文件或外部地址。"""
    document = Document()
    paragraph = document.sections[0].header.paragraphs[0]
    if simple:
        field = OxmlElement("w:fldSimple")
        field.set(qn("w:instr"), instruction)
        paragraph._p.append(field)
    else:
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        paragraph.add_run()._r.append(begin)
        for part in [instruction[:2], instruction[2:]] if split else [instruction]:
            field = OxmlElement("w:instrText")
            field.text = part
            paragraph.add_run()._r.append(field)
        end = OxmlElement("w:fldChar")
        end.set(qn("w:fldCharType"), "end")
        paragraph.add_run()._r.append(end)
    content = io.BytesIO()
    document.save(content)
    return InputFile("域模板.docx", content.getvalue())


@pytest.mark.parametrize("simple", [False, True])
@pytest.mark.parametrize(
    "instruction",
    [
        'INCLUDETEXT "file:///synthetic-missing.txt"',
        'INCLUDEPICTURE "https://synthetic.invalid/image.png"',
        "DDEAUTO synthetic application command",
    ],
)
def test_document_template_rejects_active_simple_and_complex_fields(
    simple: bool, instruction: str
) -> None:
    """两种OOXML域表示使用同一白名单，生成入口不能绕过模板检查。"""
    template = _field_template(instruction, simple, split=True)
    with pytest.raises(DomainError, match="复杂域"):
        create_document(
            {
                "title": "安全文档",
                "sections": [
                    {
                        "id": "a",
                        "title": "正文",
                        "blocks": [{"type": "paragraph", "text": "合成内容"}],
                    }
                ],
            },
            template,
        )


@pytest.mark.parametrize("simple", [False, True])
def test_document_template_preserves_safe_fields_and_checks_all_parts(simple: bool) -> None:
    """普通页码以及跨Run指令可以复用，自定义XML部件中的活动域也不能漏检。"""
    template = _field_template(" PAGE ", simple, split=True)
    assert inspect_document(template)["headerCount"] == 1
    artifact = create_document(
        {
            "title": "安全文档",
            "sections": [
                {"id": "a", "title": "正文", "blocks": [{"type": "paragraph", "text": "合成内容"}]}
            ],
        },
        template,
    )
    with zipfile.ZipFile(io.BytesIO(artifact.content)) as result:
        header = ElementTree.fromstring(result.read("word/header1.xml"))
        namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        if simple:
            field = header.find(f".//{namespace}fldSimple")
            assert field is not None and field.get(namespace + "instr", "").strip() == "PAGE"
        else:
            assert (
                "".join(field.text or "" for field in header.iter(namespace + "instrText")).strip()
                == "PAGE"
            )
    modified = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(template.content)) as original,
        zipfile.ZipFile(modified, "w") as target,
    ):
        for name in original.namelist():
            target.writestr(name, original.read(name))
        target.writestr(
            "word/custom-header.xml",
            '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr="INCLUDETEXT synthetic"/></w:hdr>',
        )
    with pytest.raises(DomainError, match="复杂域"):
        inspect_document(InputFile("隐藏域.docx", modified.getvalue()))


def test_presentation_native_chart_design_and_template_mapping() -> None:
    """PPTX图表携带嵌入数据，模板克隆后的媒体和文字仍可编辑。"""
    plan = {
        "title": "演示",
        "slides": [
            {"id": "cover", "kind": "title", "title": "测试项目", "body": ["验证正文"]},
            {
                "id": "chart",
                "kind": "chart",
                "title": "业务数据",
                "chart": {
                    "type": "bar",
                    "categories": ["甲", "乙"],
                    "series": [{"name": "金额", "values": [2, 5]}],
                },
            },
            {
                "id": "design",
                "kind": "design",
                "title": "指标",
                "design": {
                    "layout": "grid",
                    "blocks": [
                        {
                            "id": "m",
                            "type": "metric",
                            "title": "收入",
                            "value": "200万",
                            "appearance": "panel",
                        },
                        {"id": "t", "type": "text", "text": "下一步计划"},
                    ],
                },
            },
        ],
    }
    artifact = create_presentation(plan)
    presentation = Presentation(io.BytesIO(artifact.content))
    assert len(presentation.slides) == 3
    assert any(shape.has_chart for shape in presentation.slides[1].shapes)
    with zipfile.ZipFile(io.BytesIO(artifact.content)) as archive:
        assert any(name.startswith("ppt/embeddings/") for name in archive.namelist())
    template = InputFile("模板.pptx", artifact.content)
    inspected = inspect_template(template)
    assert inspected["sha256"] == template.sha256
    adapted = create_presentation(
        {
            "title": "基于模板",
            "slides": [
                {
                    "id": "copy",
                    "kind": "content",
                    "title": "新标题",
                    "body": ["新正文"],
                    "template": {
                        "slide": 1,
                        "titleShape": "cover_title",
                        "bodyShape": "cover_body",
                    },
                }
            ],
        },
        template,
    )
    revised = Presentation(io.BytesIO(adapted.content))
    assert len(revised.slides) == 1
    assert revised.slides[0].shapes[0].text == "新标题"
    assert revised.slides[0].shapes[1].text == "新正文"


def test_presentation_refuses_overlapping_content_and_unauthorized_sources() -> None:
    """图形装饰例外不能用于隐藏普通正文重叠，也不能伪造引用。"""
    plan = {
        "title": "错误方案",
        "slides": [
            {
                "id": "one",
                "kind": "design",
                "title": "布局",
                "design": {
                    "layout": "canvas",
                    "blocks": [
                        {
                            "id": identifier,
                            "type": "text",
                            "text": "正文",
                            "region": {"x": 0, "y": 0, "w": 1, "h": 1},
                        }
                        for identifier in ["a", "b"]
                    ],
                },
            }
        ],
    }
    with pytest.raises(DomainError, match="重叠"):
        create_presentation(plan)
    with pytest.raises(DomainError, match="来源"):
        create_presentation(
            {
                "title": "来源",
                "slides": [
                    {"id": "a", "kind": "title", "title": "标题", "sourceIds": ["not-authorized"]}
                ],
            }
        )

"""以原生Word结构生成可编辑文档，模板页眉页脚和样式保持独立。"""

import io
import re
import unicodedata

from docx import Document
from docx.document import Document as WordDocument
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor, Twips
from docx.text.paragraph import Paragraph

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Artifact, InputFile, record, safe_filename, sequence
from toolkits.office.document_fields import append_field, bookmark, table_of_contents
from toolkits.office.document_plan import document_plan, inspect_document
from toolkits.office.images import image_data

MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _border(paragraph: Paragraph, color: str, size: int, space: int) -> None:
    """页眉与封面使用真实段落下边线，字体变化时仍能随版心伸缩。"""
    borders, bottom = OxmlElement("w:pBdr"), OxmlElement("w:bottom")
    for key, value in {
        "val": "single",
        "color": color,
        "sz": str(size),
        "space": str(space),
    }.items():
        bottom.set(qn("w:" + key), value)
    borders.append(bottom)
    paragraph._p.get_or_add_pPr().append(borders)


def _table(document: WordDocument, block: dict[str, object], accent: str, font: str) -> None:
    columns = sequence(block["columns"], "表头", 8, 1)
    table = document.add_table(rows=1, cols=len(columns))
    table.autofit = False
    table.style = "Table Grid"
    for cell, value in zip(table.rows[0].cells, columns, strict=True):
        cell.text = str(value)
        for run in cell.paragraphs[0].runs:
            run.bold = True
    repeat = OxmlElement("w:tblHeader")
    table.rows[0]._tr.get_or_add_trPr().append(repeat)
    for raw in sequence(block["rows"], "表格行", 300):
        row = sequence(raw, "表格列", len(columns), len(columns))
        for cell, value in zip(table.add_row().cells, row, strict=True):
            cell.text = str(value)
    for index, row in enumerate(table.rows):
        row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
        for cell in row.cells:
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            properties = cell._tc.get_or_add_tcPr()
            shade = OxmlElement("w:shd")
            shade.set(
                qn("w:fill"), accent if index == 0 else "F3F6F8" if index % 2 == 0 else "FFFFFF"
            )
            properties.append(shade)
            margins, borders = OxmlElement("w:tcMar"), OxmlElement("w:tcBorders")
            for side in ("top", "bottom", "left", "right"):
                margin, border = OxmlElement("w:" + side), OxmlElement("w:" + side)
                margin.set(qn("w:w"), "100")
                margin.set(qn("w:type"), "dxa")
                margins.append(margin)
                for key, value in {"val": "single", "color": "D8E1E8", "sz": "4"}.items():
                    border.set(qn("w:" + key), value)
                borders.append(border)
            properties.extend((margins, borders))
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = 0
                paragraph.paragraph_format.line_spacing = 280 / 240
                for run in paragraph.runs:
                    run.font.name, run.font.size, run.font.bold = font, Pt(10), index == 0
                    run.font.color.rgb = RGBColor.from_string("FFFFFF" if index == 0 else "243746")
    if block.get("caption"):
        document.add_paragraph(str(block["caption"]), style="Caption")


def create_document(
    value: object,
    template: InputFile | None = None,
    sources: dict[str, dict[str, object]] | None = None,
    images: dict[str, InputFile] | None = None,
) -> Artifact:
    """引文必须出自授权原文，插图必须是已经解码检查的绑定图片。"""
    plan = document_plan(value)
    template_info = inspect_document(template) if template else {}
    document = Document(io.BytesIO(template.content)) if template else Document()
    # 直接复用整个模板关系树，只删除正文节点；页眉页脚及媒体关系不会被重建丢失。
    if template:
        for child in list(document.element.body):
            if child.tag != qn("w:sectPr"):
                document.element.body.remove(child)
    brand = record(plan["brand"], "品牌")
    font = str(brand.get("fontFace") or template_info.get("fontFace") or "Noto Sans CJK SC")
    normal = document.styles["Normal"]
    normal.font.name = font
    normal.font.size = Pt(11)
    normal.font.color.rgb = RGBColor.from_string("243746")
    normal.paragraph_format.line_spacing = 340 / 240
    normal.paragraph_format.space_after = Pt(8)
    normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), font)
    for level in range(1, 4):
        style = document.styles[f"Heading {level}"]
        style.font.name = font
        style.font.color.rgb = RGBColor.from_string(str(brand["accentColor"]))
        style.font.size = Pt((16, 13.5, 12)[level - 1])
        style.font.bold = True
        style.paragraph_format.space_before = Pt((16, 13, 11)[level - 1])
        style.paragraph_format.space_after = Pt((9, 7, 5)[level - 1])
        style.paragraph_format.keep_with_next = True
    section = document.sections[0]
    if not template:
        section.page_width, section.page_height = Twips(11906), Twips(16838)
        section.top_margin = section.bottom_margin = Inches(1)
        section.left_margin = section.right_margin = Twips(1273)
        section.header_distance = section.footer_distance = Inches(0.5)
        header = section.header.paragraphs[0]
        header.text = str(brand.get("company") or plan["title"])
        header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        _border(header, "D8E1E8", 4, 8)
        footer = section.footer.paragraphs[0]
        footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
        footer.add_run("第 ")
        append_field(footer, " PAGE ")
        footer.add_run(" 页 / 共 ")
        append_field(footer, " NUMPAGES ")
        footer.add_run(" 页")
        for paragraph in (header, footer):
            for run in paragraph.runs:
                run.font.name, run.font.size = font, Pt(9)
                run.font.color.rgb = RGBColor.from_string("657887")
    company = document.add_paragraph(str(brand.get("company") or "文档方案"))
    company.paragraph_format.space_before, company.paragraph_format.space_after = Pt(60), Pt(16)
    for run in company.runs:
        run.font.bold = True
        run.font.color.rgb = RGBColor.from_string(str(brand["accentColor"]))
    cover_title = document.add_paragraph(str(plan["title"]))
    cover_title.paragraph_format.space_after = Pt(17)
    _border(cover_title, str(brand["accentColor"]), 18, 20)
    for run in cover_title.runs:
        run.font.size, run.font.bold = Pt(24), True
        run.font.color.rgb = RGBColor.from_string("183344")
    for field in ("subtitle", "purpose"):
        if plan.get(field):
            document.add_paragraph(str(plan[field]))
    editable = document.add_paragraph("版本成果 · 可编辑文档")
    editable.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    editable.paragraph_format.space_before = Pt(27)
    document.add_page_break()
    sections = [record(section, "章节") for section in sequence(plan["sections"], "章节", 60)]
    entries = [
        (
            str(item["title"]),
            "section_" + re.sub(r"\W", "_", str(item["id"]))[:35],
            int(str(item["level"])),
        )
        for item in sections
    ]
    if any(
        record(block, "正文块")["type"] == "quote"
        for item in sections
        for block in sequence(item["blocks"], "正文", 100)
    ):
        entries.append(("资料来源", "document_sources", 1))
    if plan["tableOfContents"]:
        contents_title = document.add_paragraph("目录")
        for run in contents_title.runs:
            run.font.size, run.font.bold = Pt(18), True
            run.font.color.rgb = RGBColor.from_string(str(brand["accentColor"]))
        contents_title.paragraph_format.space_after = Pt(16)
        table_of_contents(document, entries)
        document.add_page_break()
    citations: dict[str, int] = {}
    table_count = image_count = 0
    for index, item in enumerate(sections):
        if item["pageBreakBefore"]:
            document.add_page_break()
        heading = document.add_heading(str(item["title"]), int(str(item["level"])))
        bookmark(heading, index + 1, entries[index][1])
        for raw_block in sequence(item["blocks"], "正文", 100):
            block = record(raw_block, "正文块")
            kind = block["type"]
            if kind == "paragraph":
                document.add_paragraph(str(block["text"]))
            elif kind == "list":
                for line in sequence(block["items"], "列表", 60):
                    document.add_paragraph(
                        str(line), style="List Number" if block["ordered"] else "List Bullet"
                    )
            elif kind == "table":
                _table(document, block, str(brand["accentColor"]), font)
                table_count += 1
            elif kind == "image":
                image = (images or {}).get(str(block["imageId"]))
                if image is None:
                    raise DomainError(403, "图片不在本次授权输入中")
                data, width, height = image_data(image)
                available = (
                    int(section.page_width or Inches(8.27))
                    - int(section.left_margin or Inches(1))
                    - int(section.right_margin or Inches(1))
                ) / 914400
                image_width = min(available, 6, 5 * width / height)
                document.add_picture(io.BytesIO(data), width=Inches(image_width))
                if block.get("caption"):
                    document.add_paragraph(str(block["caption"]), style="Caption")
                image_count += 1
            elif kind == "quote":
                identifier = str(block["sourceId"])
                source = (sources or {}).get(identifier)

                def normalize(value: object) -> str:
                    return re.sub(r"\s", "", unicodedata.normalize("NFKC", str(value)))

                if source is None or normalize(block["text"]) not in normalize(
                    source.get("text", "")
                ):
                    raise DomainError(422, "引用未匹配授权原文")
                citation = citations.setdefault(identifier, len(citations) + 1)
                document.add_paragraph(str(block["text"]) + f" [{citation}]", style="Quote")
    if citations:
        heading = document.add_heading("资料来源", 1)
        bookmark(heading, len(sections) + 1, "document_sources")
        for identifier, number in citations.items():
            source = (sources or {})[identifier]
            document.add_paragraph(
                f"[{number}] {source.get('filename', identifier)} · {identifier}"
            )
    output = io.BytesIO()
    document.save(output)
    return Artifact(
        safe_filename(plan["title"], ".docx"),
        output.getvalue(),
        MEDIA_TYPE,
        plan,
        {
            "sections": len(sequence(plan["sections"], "章节", 60)),
            "tableCount": table_count,
            "imageCount": image_count,
            "sourceIds": list(citations),
            "fontFamilies": [font],
            "templateSha256": template.sha256 if template else None,
        },
    )

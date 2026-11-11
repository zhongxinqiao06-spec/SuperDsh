"""Word方案验证、授权引文与模板结构检查。"""

import json
import re
from xml.etree.ElementTree import Element

from defusedxml import ElementTree

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import InputFile, color, office_archive, record, sequence, text


def document_plan(value: object) -> dict[str, object]:
    """只允许普通段落、列表、表格、图片和原文引用，不支持任意XML。"""
    source = record(value, "Word方案")
    brand = record(source.get("brand", {}), "品牌")
    font = text(brand["fontFace"], "字体", 80) if brand.get("fontFace") else None
    if font and re.search(r"[<>\\/]", font):
        raise DomainError(422, "字体名称无效")
    seen: set[str] = set()
    sections: list[dict[str, object]] = []
    for raw in sequence(source.get("sections"), "章节", 60, 1):
        section = record(raw, "章节")
        identifier = text(section.get("id"), "章节ID", 100)
        if identifier in seen:
            raise DomainError(422, "章节ID重复")
        seen.add(identifier)
        level = section.get("level", 1)
        if type(level) is not int or level not in {1, 2, 3}:
            raise DomainError(422, "标题级别只能为1、2、3")
        blocks: list[dict[str, object]] = []
        for item in sequence(section.get("blocks"), "章节内容", 100, 1):
            block = record(item, "正文块")
            kind = block.get("type")
            if kind == "paragraph":
                blocks.append({"type": kind, "text": text(block.get("text"), "段落", 8000)})
            elif kind == "quote":
                blocks.append(
                    {
                        "type": kind,
                        "text": text(block.get("text"), "引用", 3000),
                        "sourceId": text(block.get("sourceId"), "来源ID", 200),
                    }
                )
            elif kind == "image":
                blocks.append(
                    {
                        "type": kind,
                        "imageId": text(block.get("imageId"), "图片ID", 200),
                        "caption": text(block["caption"], "图注", 300)
                        if block.get("caption")
                        else "",
                    }
                )
            elif kind == "list":
                blocks.append(
                    {
                        "type": kind,
                        "items": [
                            text(item, "列表项", 1000)
                            for item in sequence(block.get("items"), "列表", 60, 1)
                        ],
                        "ordered": block.get("ordered") is True,
                    }
                )
            elif kind == "table":
                columns = [
                    text(item, "表头", 100) for item in sequence(block.get("columns"), "表头", 8, 1)
                ]
                rows: list[list[str]] = []
                for raw_row in sequence(block.get("rows"), "表格行", 300, 1):
                    row = sequence(raw_row, "表格列", len(columns), len(columns))
                    rows.append(
                        [
                            text(
                                str(cell) if isinstance(cell, (int, float)) else cell,
                                "单元格",
                                800,
                                empty=True,
                            )
                            for cell in row
                        ]
                    )
                blocks.append(
                    {
                        "type": kind,
                        "columns": columns,
                        "rows": rows,
                        "caption": text(block["caption"], "表注", 300)
                        if block.get("caption")
                        else "",
                    }
                )
            else:
                raise DomainError(422, "Word内容类型不受支持")
        sections.append(
            {
                "id": identifier,
                "title": text(section.get("title"), "章节标题", 160),
                "level": level,
                "pageBreakBefore": section.get("pageBreakBefore") is True,
                "blocks": blocks,
            }
        )
    if len(json.dumps(sections, ensure_ascii=False)) > 150000:
        raise DomainError(422, "Word正文过长，请拆分文档")
    if "tableOfContents" in source and type(source["tableOfContents"]) is not bool:
        raise DomainError(422, "目录开关必须是布尔值")
    result: dict[str, object] = {
        "title": text(source.get("title"), "标题", 120),
        "sections": sections,
        "tableOfContents": source.get("tableOfContents", True),
        "brand": {**brand, "accentColor": color(brand.get("accentColor"))},
    }
    for field in ("subtitle", "purpose"):
        if field in source:
            result[field] = text(source[field], field, 300)
    return result


def _check_fields(xml: Element, namespace: str) -> None:
    """简单域和跨Run复杂域共用白名单；嵌套域逐个验证，不执行外部文件/数据域。"""

    def check(instruction: str) -> None:
        if len(instruction) > 2000 or not re.match(
            r"\s*(PAGE|NUMPAGES|TOC|PAGEREF|REF)\b", instruction, re.I
        ):
            raise DomainError(422, "Word模板包含不支持的复杂域")

    fields: list[list[str] | None] = []
    for element in xml.iter():
        if element.tag == f"{{{namespace}}}fldSimple":
            check(element.get(f"{{{namespace}}}instr", ""))
        elif element.tag == f"{{{namespace}}}fldChar":
            kind = element.get(f"{{{namespace}}}fldCharType")
            if kind == "begin" and len(fields) < 32:
                fields.append([])
            elif kind in {"separate", "end"} and fields:
                current = fields[-1]
                if current is not None:
                    check("".join(current))
                if kind == "end":
                    fields.pop()
                else:
                    fields[-1] = None
            else:
                raise DomainError(422, "Word模板包含不完整或过深的复杂域")
        elif element.tag == f"{{{namespace}}}instrText":
            if not fields or fields[-1] is None:
                raise DomainError(422, "Word模板包含不完整的复杂域")
            fields[-1].append(element.text or "")
    if fields:
        raise DomainError(422, "Word模板包含未结束的复杂域")


def inspect_document(file: InputFile) -> dict[str, object]:
    """企业模板保留页眉页脚和样式，仅支持可可靠复用的单节正文。"""
    archive = office_archive(file)
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    root = ElementTree.fromstring(archive["word/document.xml"])
    if len(root.findall(f".//{{{namespace}}}sectPr")) != 1 or any(
        root.findall(f".//{{{namespace}}}{name}")
        for name in ("altChunk", "object", "sdt", "txbxContent")
    ):
        raise DomainError(422, "请使用无复杂分节、内容控件或文本框的普通Word模板")
    for name, content in archive.items():
        # 页眉/脚注可使用自定义部件名，不能只检查 header1.xml 等惯例名称。
        if name.startswith("word/") and name.endswith(".xml"):
            _check_fields(ElementTree.fromstring(content), namespace)
    styles = ElementTree.fromstring(archive.get("word/styles.xml", b"<styles/>"))
    fonts = styles.findall(f".//{{{namespace}}}rFonts")
    font = (
        (fonts[0].get(f"{{{namespace}}}eastAsia") or fonts[0].get(f"{{{namespace}}}ascii"))
        if fonts
        else None
    )
    return {
        "fontFace": font,
        "headerCount": len(root.findall(f".//{{{namespace}}}headerReference")),
        "footerCount": len(root.findall(f".//{{{namespace}}}footerReference")),
        "styles": [
            {
                "id": item.get(f"{{{namespace}}}styleId"),
                "name": next(
                    (
                        child.get(f"{{{namespace}}}val")
                        for child in item
                        if child.tag == f"{{{namespace}}}name"
                    ),
                    None,
                ),
            }
            for item in styles.findall(f"{{{namespace}}}style")
        ][:150],
        "sha256": file.sha256,
    }

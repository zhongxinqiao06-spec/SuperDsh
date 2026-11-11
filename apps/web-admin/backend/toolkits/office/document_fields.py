"""Word 可更新域与真实目录缓存，首开预览即可看到已确认章节。"""

from docx.document import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph


def append_field(paragraph: Paragraph, instruction: str, fallback: str = "") -> None:
    """插入可更新域及可选已有结果；不虚构未知页码。"""
    begin, text, separate, end = (
        OxmlElement("w:" + name) for name in ("fldChar", "instrText", "fldChar", "fldChar")
    )
    begin.set(qn("w:fldCharType"), "begin")
    begin.set(qn("w:dirty"), "true")
    text.set(qn("xml:space"), "preserve")
    text.text = instruction
    separate.set(qn("w:fldCharType"), "separate")
    end.set(qn("w:fldCharType"), "end")
    for element in (begin, text, separate):
        paragraph.add_run()._r.append(element)
    if fallback:
        paragraph.add_run(fallback)
    paragraph.add_run()._r.append(end)


def bookmark(paragraph: Paragraph, identifier: int, name: str) -> None:
    """章节和资料来源共享可跳转书签，目录引用不指向不存在的节点。"""
    start, end = OxmlElement("w:bookmarkStart"), OxmlElement("w:bookmarkEnd")
    start.set(qn("w:id"), str(identifier))
    start.set(qn("w:name"), name)
    end.set(qn("w:id"), str(identifier))
    paragraph._p.insert(0, start)
    paragraph._p.append(end)


def table_of_contents(document: Document, entries: list[tuple[str, str, int]]) -> None:
    """SDT 内保存章节标题和 PAGEREF 域，Office 更新目录时仍可重新生成。"""
    wrapper, properties, content = (
        OxmlElement("w:" + name) for name in ("sdt", "sdtPr", "sdtContent")
    )
    alias = OxmlElement("w:alias")
    alias.set(qn("w:val"), "目录")
    properties.append(alias)
    part, gallery = OxmlElement("w:docPartObj"), OxmlElement("w:docPartGallery")
    gallery.set(qn("w:val"), "Table of Contents")
    part.append(gallery)
    part.append(OxmlElement("w:docPartUnique"))
    properties.append(part)
    wrapper.extend((properties, content))
    for index, (title, anchor, level) in enumerate(entries):
        paragraph = document.add_paragraph()
        paragraph_properties = paragraph._p.get_or_add_pPr()
        style, tabs, tab = (OxmlElement("w:" + name) for name in ("pStyle", "tabs", "tab"))
        style.set(qn("w:val"), "TOC" + str(level))
        paragraph_properties.append(style)
        for name, value in {"val": "right", "pos": "9360", "leader": "dot"}.items():
            tab.set(qn("w:" + name), value)
        tabs.append(tab)
        paragraph_properties.append(tabs)
        if index == 0:
            append_field(paragraph, ' TOC \\h \\o "1-3" ')
            # 总目录域的 end 必须位于所有缓存条目之后。
            paragraph._p.remove(paragraph._p[-1])
        hyperlink = OxmlElement("w:hyperlink")
        hyperlink.set(qn("w:history"), "1")
        hyperlink.set(qn("w:anchor"), anchor)
        temporary = document.add_paragraph(title)
        temporary.add_run().add_tab()
        append_field(temporary, f" PAGEREF {anchor} \\h ")
        for run in list(temporary._p):
            hyperlink.append(run)
        temporary._p.getparent().remove(temporary._p)
        paragraph._p.append(hyperlink)
        content.append(paragraph._p)
    closing = OxmlElement("w:p")
    run, end = OxmlElement("w:r"), OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run.append(end)
    closing.append(run)
    content.append(closing)
    document.element.body.insert_element_before(wrapper, "w:sectPr")
    settings = document.settings.element
    if settings.find(qn("w:updateFields")) is None:
        settings.append(OxmlElement("w:updateFields"))

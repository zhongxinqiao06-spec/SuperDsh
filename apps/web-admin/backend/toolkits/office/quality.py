"""检查实际PDF渲染的文字保留、页面边界和字体，绝不凭文件存在宣布通过。"""

import re
import unicodedata
from pathlib import Path

from app.infrastructure.errors import DomainError


def normalized(value: str) -> str:
    """对照忽略排版空白，保留标点和全部实质文字。"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value))


def expected_text(plan: dict[str, object]) -> list[str]:
    """只提取需要可见的内容，不把备注、来源ID或主题配置当正文。"""
    result: list[str] = []

    def collect(value: object, key: str = "") -> None:
        if isinstance(value, dict):
            for name, child in value.items():
                if name in {
                    "title",
                    "subtitle",
                    "text",
                    "caption",
                    "body",
                    "items",
                    "value",
                    "columns",
                    "rows",
                    "sections",
                    "slides",
                    "blocks",
                    "design",
                    "table",
                }:
                    collect(child, name)
        elif isinstance(value, list):
            for child in value:
                collect(child, key)
        elif isinstance(value, str) and len(normalized(value)) >= 2:
            result.append(value)

    # PPT文档属性标题不一定出现在幻灯片中，不能把元数据当成丢失的正文。
    collect(
        {key: value for key, value in plan.items() if key != "title"} if "slides" in plan else plan
    )
    return list(dict.fromkeys(result))


def inspect_pdf(payload: dict[str, object], directory: str) -> dict[str, object]:
    """在受管CPU进程运行PDFium，返回有界报告和真实页面缩略图文件。"""
    # 原生 PDFium 的加载和文档解析均归工作进程，纯文本规则可安全复用。
    import pypdfium2  # type: ignore[import-untyped]  # 原生绑定尚未提供类型声明。
    from pypdf import PdfReader

    source = Path(str(payload["pdfPath"]))
    output = Path(str(payload["outputDirectory"]))
    output.mkdir(parents=True, exist_ok=True)
    if source.stat().st_size > 40 * 1024 * 1024:
        raise DomainError(413, "预览PDF过大")
    reader = PdfReader(source)
    document = pypdfium2.PdfDocument(str(source))
    try:
        if not 1 <= len(document) <= 100:
            raise DomainError(413, "渲染页数超过100页，请拆分文档")
        contents: list[str] = []
        pages: list[dict[str, object]] = []
        fonts: set[str] = set()
        issues: list[dict[str, object]] = []
        for index in range(len(document)):
            page = document[index]
            text_page = page.get_textpage()
            try:
                width, height = page.get_size()
                if not 0 < width <= 2880 or not 0 < height <= 2880:
                    raise DomainError(422, "渲染页面大小异常")
                content = text_page.get_text_range()
                contents.append(content)
                outside = 0
                if text_page.count_chars() > 150000:
                    raise DomainError(413, "单页文字过多")
                for character in range(text_page.count_chars()):
                    left, bottom, right, top = text_page.get_charbox(character)
                    if left < -1 or bottom < -1 or right > width + 1 or top > height + 1:
                        outside += 1
                if outside:
                    issues.append(
                        {
                            "code": "page_bounds",
                            "page": index + 1,
                            "message": "渲染文字越出页面",
                            "count": outside,
                        }
                    )
                thumbnail = None
                if index < 20:
                    bitmap = page.render(scale=min(1.5, 1400 / max(width, height)))
                    try:
                        filename = "page-" + str(index + 1) + ".png"
                        bitmap.to_pil().save(output / filename)
                        thumbnail = filename
                    finally:
                        bitmap.close()
                pages.append(
                    {
                        "page": index + 1,
                        "width": width,
                        "height": height,
                        "textLength": len(content),
                        "outsideCharacters": outside,
                        "thumbnail": thumbnail,
                    }
                )
                resources = reader.pages[index].get("/Resources", {})
                if hasattr(resources, "get_object"):
                    resources = resources.get_object()
                font_resources = resources.get("/Font", {})
                if hasattr(font_resources, "get_object"):
                    font_resources = font_resources.get_object()
                for font in font_resources.values():
                    definition = font.get_object()
                    fonts.add(str(definition.get("/BaseFont", "")).lstrip("/"))
            finally:
                text_page.close()
                page.close()
        combined = normalized("\n".join(contents))
        raw_expected = payload.get("expectedText", [])
        expected = [str(value) for value in raw_expected] if isinstance(raw_expected, list) else []
        missing = [value for value in expected if normalized(value) not in combined]
        if missing:
            issues.append(
                {
                    "code": "text_preservation",
                    "message": "部分正文未在渲染结果中找到",
                    "count": len(missing),
                    "samples": [value[:200] for value in missing[:10]],
                }
            )
        if "\ufffd" in combined:
            issues.append({"code": "missing_glyphs", "message": "渲染文字含替换字符"})
        requested = payload.get("fontFamilies", [])
        families = [str(value) for value in requested] if isinstance(requested, list) else []
        font_keys = [re.sub(r"[^a-z0-9]", "", value.casefold()) for value in fonts]
        missing_fonts = [
            value
            for value in families
            if not any(re.sub(r"[^a-z0-9]", "", value.casefold()) in key for key in font_keys)
        ]
        if missing_fonts:
            issues.append(
                {
                    "code": "font_substitution",
                    "message": "指定字体未在渲染PDF中找到",
                    "fonts": missing_fonts,
                }
            )
        return {
            "status": "draft" if issues else "passed",
            "renderer": "libreoffice",
            "pageCount": len(pages),
            "pages": pages,
            "issues": issues,
            "missingFonts": missing_fonts,
            "fonts": sorted(fonts),
            "textPreserved": not missing,
            "boundsChecked": True,
            "rendered": True,
            "visualModelReviewed": False,
            "officeClientReviewed": False,
            "calculationVerified": payload.get("calculationVerified") is True,
            "correctionRounds": 0,
        }
    finally:
        document.close()

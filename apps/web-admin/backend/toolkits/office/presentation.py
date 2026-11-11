"""生成保留原生文字、表格、图表和模板关系的可编辑PPTX成果。"""

import io

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR
from pptx.util import Inches

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Artifact, InputFile, record, safe_filename, sequence
from toolkits.office.presentation_brand import draw_brand_frame
from toolkits.office.presentation_drawing import (
    Region,
    draw_chart,
    draw_image,
    draw_table,
    font_size,
    textbox,
    write_text,
)
from toolkits.office.presentation_layout import draw_design
from toolkits.office.presentation_plan import presentation_plan
from toolkits.office.presentation_template import clone_slide, find_text, load_template


def create_presentation(
    value: object,
    template: InputFile | None = None,
    images: dict[str, InputFile] | None = None,
    sources: dict[str, dict[str, object]] | None = None,
) -> Artifact:
    """输入素材均已授权；所有来源标识再次检查，原成果不会被覆盖。"""
    plan = presentation_plan(value)
    theme = record(plan["designTheme"], "主题")
    brand = record(plan["brand"], "品牌")
    for key, target in {
        "fontFace": "fontFace",
        "accentColor": "accent",
        "textColor": "foreground",
        "backgroundColor": "background",
    }.items():
        if key in brand:
            theme[target] = brand[key]
    presentation = load_template(template) if template else Presentation()
    if not template:
        presentation.slide_width, presentation.slide_height = Inches(13.333333), Inches(7.5)
    assert presentation.slide_width is not None and presentation.slide_height is not None
    width, height = presentation.slide_width.inches, presentation.slide_height.inches
    original_slides = list(presentation.slides)
    original_ids = list(presentation.slides._sldIdLst)
    definitions = [record(slide, "页面") for slide in sequence(plan["slides"], "页面", 20)]
    for index, definition in enumerate(definitions, 1):
        cover = definition["kind"] == "title"
        mapping = record(definition.get("template", {}), "模板映射")
        if template:
            number = mapping.get("slide")
            if not isinstance(number, int) or number > len(original_slides):
                raise DomainError(422, "使用模板时每页必须指定有效模板页码")
            slide = clone_slide(presentation, original_slides[number - 1])
        else:
            if mapping:
                raise DomainError(422, "模板映射缺少模板输入")
            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            slide.background.fill.solid()
            slide.background.fill.fore_color.rgb = RGBColor.from_string(str(theme["background"]))
        for source in sequence(definition.get("sourceIds", []), "来源", 50):
            if str(source) not in (sources or {}):
                raise DomainError(403, "页面引用了未授权的来源")
        title_shape = find_text(slide, mapping.get("titleShape"), True) if template else None
        if title_shape is not None:
            title_area = Region(
                title_shape.left.inches,
                title_shape.top.inches,
                title_shape.width.inches,
                title_shape.height.inches,
            )
            write_text(
                title_shape,
                [str(definition["title"])],
                str(theme["fontFace"]),
                str(theme["foreground"]),
                font_size([str(definition["title"])], title_area, 30),
                True,
            )
        else:
            heading = textbox(
                slide,
                [str(definition["title"])],
                Region(0.65, 1.65 if cover else 0.55, width - 1.3, 1.4 if cover else 0.9),
                theme,
                42 if cover else 32,
                True,
                foreground=str(theme["accent"]),
                name=str(definition["id"]) + "_title",
            )
            heading.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            heading.text_frame.margin_top = heading.text_frame.margin_bottom = 0
            heading.text_frame.margin_left = heading.text_frame.margin_right = 0
        if "contentRegion" in mapping:
            raw = record(mapping["contentRegion"], "区域")
            area = Region(*(float(str(raw[key])) for key in ("x", "y", "w", "h")))
        else:
            area = Region(
                0.65, 3.3 if cover else 1.7, width - 1.3, height - (4.25 if cover else 2.45)
            )
        if area.x + area.w > width or area.y + area.h > height or area.w <= 0 or area.h <= 0:
            raise DomainError(422, "模板内容区域超出页面")
        kind = definition["kind"]
        body = [str(item) for item in sequence(definition.get("body", []), "正文", 12)]
        if body:
            body_area = area
            if kind not in {"content", "title", "design"}:
                caption_height = sum(
                    max(1, len(line) * 20 / (area.w * 72)) * 20 * 1.35 / 72 for line in body
                )
                if caption_height + 0.2 > area.h * 0.35:
                    raise DomainError(422, "媒体说明超出可读区域，请移到单独页面")
                body_area = Region(area.x, area.y, area.w, caption_height)
                area = Region(
                    area.x, area.y + caption_height + 0.2, area.w, area.h - caption_height - 0.2
                )
            shape = find_text(slide, mapping.get("bodyShape")) if template else None
            if shape and kind in {"content", "title"}:
                area = Region(
                    shape.left.inches, shape.top.inches, shape.width.inches, shape.height.inches
                )
                write_text(
                    shape,
                    body,
                    str(theme["fontFace"]),
                    str(theme["foreground"]),
                    font_size(body, area, 20),
                )
            else:
                textbox(slide, body, body_area, theme, 20, name=str(definition["id"]) + "_body")
        if kind == "table":
            draw_table(slide, definition["table"], area, theme)
        elif kind == "chart":
            draw_chart(slide, definition["chart"], area, theme)
        elif kind == "image":
            draw_image(slide, definition["imageId"], area, images or {})
        elif kind == "design":
            draw_design(slide, definition["design"], area, theme, images or {})
        if not template:
            draw_brand_frame(
                slide,
                theme,
                width,
                height,
                str(brand.get("company", "")),
                index,
                len(definitions),
                cover,
            )
        notes = str(definition.get("notes", ""))
        if definition.get("sourceIds"):
            notes += "\n来源：" + ", ".join(
                str(value) for value in sequence(definition["sourceIds"], "来源", 50)
            )
        if slide.notes_slide.notes_text_frame is not None:
            slide.notes_slide.notes_text_frame.text = notes
    # 只移除模板的原页面引用；克隆页面引用的母版/媒体关系由包序列化保留。
    for identifier in original_ids:
        presentation.part.drop_rel(identifier.rId)
        presentation.slides._sldIdLst.remove(identifier)
    output = io.BytesIO()
    presentation.core_properties.title = str(plan["title"])
    presentation.save(output)
    return Artifact(
        safe_filename(plan["title"], ".pptx"),
        output.getvalue(),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        plan,
        {
            "plan": plan,
            "slideCount": len(definitions),
            "templateSha256": template.sha256 if template else None,
            "fontFamilies": [theme["fontFace"]],
            "editable": True,
        },
    )

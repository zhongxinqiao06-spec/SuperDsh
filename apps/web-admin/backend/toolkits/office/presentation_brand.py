"""通用演示主题页框；品牌颜色与文案由已确认方案提供。"""

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.xmlchemy import OxmlElement
from pptx.slide import Slide
from pptx.util import Pt

from toolkits.office.presentation_drawing import Region, native_shape, textbox


def draw_brand_frame(
    slide: Slide,
    theme: dict[str, object],
    width: float,
    height: float,
    company: str,
    page: int,
    count: int,
    cover: bool,
) -> None:
    """默认页框保留既有品牌标线、封面装饰与总页数，不改用户模板的原有对象。"""
    native_shape(
        slide,
        "rect",
        Region(0.65, 1.2 if cover else 0.27, 1.1 if cover else 0.6, 0.07),
        str(theme["accent"]),
        "brand-accent",
    )
    if cover:
        for name, area, color, thickness in (
            ("outer", Region(width - 3.6, height - 3.1, 2.7, 2.7), "accent", 2.0),
            ("inner", Region(width - 3.1, height - 2.6, 1.7, 1.7), "secondary", 1.5),
        ):
            shape = native_shape(
                slide, "ellipse", area, str(theme["background"]), "brand-decoration-" + name
            )
            shape.fill.background()
            shape.line.color.rgb = RGBColor.from_string(str(theme[color]))
            shape.line.width = Pt(thickness)
            color_node = shape.line._get_or_add_ln().find(
                "{http://schemas.openxmlformats.org/drawingml/2006/main}solidFill"
            )
            if color_node is not None and len(color_node):
                opacity = OxmlElement("a:alpha")
                opacity.set("val", "50000")
                color_node[0].append(opacity)
    for name, text, area, align in (
        (
            "brand-footer",
            company or "SUPERDSH",
            Region(0.65, height - 0.4, width - 2.6, 0.18),
            PP_ALIGN.LEFT,
        ),
        (
            "brand-page",
            f"{page:02d} / {count:02d}",
            Region(width - 1.65, height - 0.4, 1, 0.18),
            PP_ALIGN.RIGHT,
        ),
    ):
        shape = textbox(slide, [text], area, theme, 9, foreground=str(theme["muted"]), name=name)
        frame = shape.text_frame
        frame.margin_top = frame.margin_bottom = frame.margin_left = frame.margin_right = 0
        frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        for paragraph in frame.paragraphs:
            paragraph.alignment = align
            paragraph.space_after = 0
            if name == "brand-footer":
                for run in paragraph.runs:
                    run._r.get_or_add_rPr().set("spc", "100")

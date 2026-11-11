"""PPT原生文字、表格、图表及图片绘制；所有元素均有明确页面区域。"""

import io
import math
from dataclasses import dataclass
from typing import cast

from pptx.chart.data import ChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.xmlchemy import OxmlElement
from pptx.shapes.autoshape import Shape
from pptx.shapes.graphfrm import GraphicFrame
from pptx.slide import Slide
from pptx.util import Inches, Pt

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import InputFile, record, sequence
from toolkits.office.images import image_data


@dataclass(frozen=True)
class Region:
    """英寸区域用于最终绘制，比例布局在进入此契约前转换。"""

    x: float
    y: float
    w: float
    h: float

    def inset(self, amount: float) -> "Region":
        """给组件留内边距，过小组件拒绝绘制。"""
        if self.w <= amount * 2 or self.h <= amount * 2:
            raise DomainError(422, "组件区域太小")
        return Region(self.x + amount, self.y + amount, self.w - amount * 2, self.h - amount * 2)


def font_size(lines: list[str], area: Region, preferred: int, minimum: int = 12) -> int:
    """按中英字宽保守估算字号；最终仍以实际PDF渲染检查为准。"""
    for size in range(preferred, minimum - 1, -1):
        width = max(1.0, (area.w - 0.1) * 72 / size)
        count = sum(
            max(1, math.ceil(sum(1 if ord(char) > 255 else 0.55 for char in line) / width))
            for line in lines
        )
        if count * size * 1.3 + max(0, len(lines) - 1) * 6 <= area.h * 72:
            return size
    raise DomainError(422, "页面文字过密，请拆页或扩大区域")


def write_text(
    shape: Shape, lines: list[str], face: str, foreground: str, size: int, bold: bool = False
) -> None:
    """修改文字时保留形状本身及模板位置，不扁平化成图片。"""
    frame = shape.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = Inches(0.04)
    frame.margin_top = frame.margin_bottom = Inches(0.03)
    frame.vertical_anchor = MSO_ANCHOR.TOP
    for index, value in enumerate(lines):
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.text = value
        paragraph.font.name, paragraph.font.size, paragraph.font.bold = face, Pt(size), bold
        # python-pptx 的 name 只声明拉丁字体；中文必须同时声明东亚字体，
        # 否则 LibreOffice/Office 会按模板主题替换成另一套字体。
        properties = paragraph._p.get_or_add_pPr().get_or_add_defRPr()
        properties.set("lang", "zh-CN")
        properties.set("altLang", "en-US")
        for tag in ("a:ea", "a:cs"):
            for existing in properties.findall(
                "{http://schemas.openxmlformats.org/drawingml/2006/main}" + tag.split(":")[1]
            ):
                properties.remove(existing)
            element = OxmlElement(tag)
            element.set("typeface", face)
            properties.append(element)
        paragraph.font.color.rgb = RGBColor.from_string(foreground)
        paragraph.space_after = Pt(6)
        paragraph.line_spacing = 1.15
        paragraph.alignment = PP_ALIGN.LEFT
        for run in paragraph.runs:
            # 同时写入每个文本段，避免渲染器忽略段落默认字体的东亚属性。
            run.font.name, run.font.size, run.font.bold = face, Pt(size), bold
            run_properties = run._r.get_or_add_rPr()
            run_properties.set("lang", "zh-CN")
            for tag in ("a:ea", "a:cs"):
                element = OxmlElement(tag)
                element.set("typeface", face)
                run_properties.append(element)


def textbox(
    slide: Slide,
    lines: list[str],
    area: Region,
    theme: dict[str, object],
    size: int = 24,
    bold: bool = False,
    foreground: str | None = None,
    name: str = "",
) -> Shape:
    """原生文本框保持文字可搜索/可编辑。"""
    shape = slide.shapes.add_textbox(Inches(area.x), Inches(area.y), Inches(area.w), Inches(area.h))
    if name:
        shape.name = name
    write_text(
        shape,
        lines,
        str(theme["fontFace"]),
        foreground or str(theme["foreground"]),
        font_size(lines, area, size, min(12, size)),
        bold,
    )
    return shape


def native_shape(slide: Slide, kind: str, area: Region, color: str, name: str) -> Shape:
    """使用固定原生形状集合，不执行模型提供的SVG或脚本。"""
    shape_type = {
        "rect": MSO_SHAPE.RECTANGLE,
        "roundRect": MSO_SHAPE.ROUNDED_RECTANGLE,
        "ellipse": MSO_SHAPE.OVAL,
        "line": MSO_SHAPE.RECTANGLE,
        "chevron": MSO_SHAPE.CHEVRON,
        "rightArrow": MSO_SHAPE.RIGHT_ARROW,
    }[kind]
    shape = slide.shapes.add_shape(
        shape_type,
        Inches(area.x),
        Inches(area.y),
        Inches(area.w),
        Inches(min(area.h, 0.03) if kind == "line" else area.h),
    )
    shape.name = name
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor.from_string(color)
    shape.line.fill.background()
    return shape


def draw_table(slide: Slide, value: object, area: Region, theme: dict[str, object]) -> None:
    """表格保留真实单元格，文字不通过截图替代。"""
    definition = record(value, "表格")
    columns = [str(value) for value in sequence(definition["columns"], "字段", 8)]
    rows = [
        # 数值校验会归一成 float；显示整数时保持旧可编辑表格的“20”而非“20.0”。
        [
            str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)
            for value in sequence(row, "行", 8)
        ]
        for row in sequence(definition["rows"], "行", 15)
    ]
    size = font_size([" ".join(row) for row in [columns, *rows]], area, 17, 10)
    table = slide.shapes.add_table(
        len(rows) + 1, len(columns), Inches(area.x), Inches(area.y), Inches(area.w), Inches(area.h)
    ).table
    for row_index, values in enumerate([columns, *rows]):
        for column, value in enumerate(values):
            cell = table.cell(row_index, column)
            cell.text = value
            cell.margin_left = cell.margin_right = Pt(5)
            cell.margin_top = cell.margin_bottom = Pt(5)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.fill.solid()
            cell.fill.fore_color.rgb = RGBColor.from_string(
                str(theme["accent"] if row_index == 0 else theme["background"])
            )
            # 原生表格边线显式保存，避免默认主题给迁移成果换成白色或缺失边框。
            for edge in ("lnL", "lnR", "lnT", "lnB"):
                border = OxmlElement("a:" + edge)
                border.set("w", "6350")
                fill = OxmlElement("a:solidFill")
                color = OxmlElement("a:srgbClr")
                color.set("val", "CDD7E0")
                fill.append(color)
                border.append(fill)
                cell._tc.get_or_add_tcPr().append(border)
            for paragraph in cell.text_frame.paragraphs:
                paragraph.font.name, paragraph.font.size = str(theme["fontFace"]), Pt(size)
                paragraph.font.bold = row_index == 0
                paragraph.font.color.rgb = RGBColor.from_string(
                    "FFFFFF" if row_index == 0 else str(theme["foreground"])
                )


def draw_chart(slide: Slide, value: object, area: Region, theme: dict[str, object]) -> None:
    """图表内含可编辑工作簿数据，系列数据不会退化成位图。"""
    definition = record(value, "图表")
    data = ChartData()
    data.categories = [str(value) for value in sequence(definition["categories"], "分类", 24)]
    for raw in sequence(definition["series"], "系列", 6):
        series = record(raw, "系列")
        values = [float(str(value)) for value in sequence(series["values"], "数值", 24)]
        data.add_series(str(series["name"]), values)
    # python-pptx当前注解写成Chart，实际公开API返回承载Chart的GraphicFrame。
    chart_frame = slide.shapes.add_chart(
        {
            "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
            "line": XL_CHART_TYPE.LINE_MARKERS,
            "pie": XL_CHART_TYPE.PIE,
        }[str(definition["type"])],
        Inches(area.x),
        Inches(area.y),
        Inches(area.w),
        Inches(area.h),
        data,
    )
    chart = cast(GraphicFrame, chart_frame).chart
    chart.has_legend = len(chart.series) > 1
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.font.name, chart.legend.font.size = str(theme["fontFace"]), Pt(14)
    chart.font.name, chart.font.size = str(theme["fontFace"]), Pt(14)
    palette = (str(theme["accent"]), "188A9A", "E9A23B", "796AC0", "589A6E", "CE6B57")
    for index, series in enumerate(chart.series):
        series.format.fill.solid()
        series.format.fill.fore_color.rgb = RGBColor.from_string(palette[index % len(palette)])
    if definition["type"] == "pie":
        plot = chart.plots[0]
        plot.has_data_labels = True
        plot.data_labels.show_category_name = True
        plot.data_labels.show_percentage = True
        plot.data_labels.show_value = True
    if definition.get("valueUnit") and definition["type"] != "pie":
        chart.value_axis.has_title = True
        chart.value_axis.axis_title.text_frame.text = str(definition["valueUnit"])


def draw_image(
    slide: Slide, identifier: object, area: Region, images: dict[str, InputFile]
) -> None:
    """图片只能取本次授权输入，保持比例且不越出内容区域。"""
    source = images.get(str(identifier))
    if source is None:
        raise DomainError(403, "图片不在本次授权素材中")
    content, width, height = image_data(source)
    scale = min(area.w / width, area.h / height)
    w, h = width * scale, height * scale
    slide.shapes.add_picture(
        io.BytesIO(content),
        Inches(area.x + (area.w - w) / 2),
        Inches(area.y + (area.h - h) / 2),
        Inches(w),
        Inches(h),
    )

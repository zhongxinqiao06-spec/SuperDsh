"""确定性设计布局与组件装配，canvas的有意装饰叠放需明确声明。"""

import math

from pptx.slide import Slide

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import InputFile, record, sequence
from toolkits.office.presentation_drawing import (
    Region,
    draw_chart,
    draw_image,
    draw_table,
    native_shape,
    textbox,
)


def block_regions(design: dict[str, object], area: Region) -> list[Region]:
    """布局仅映射矩形，内容绘制与布局规则保持分离。"""
    blocks = sequence(design["blocks"], "组件", 16)
    layout = design["layout"]
    if layout == "canvas":
        output: list[Region] = []
        for block in blocks:
            region = record(record(block, "组件")["region"], "区域")
            output.append(
                Region(
                    area.x + float(str(region["x"])) * area.w,
                    area.y + float(str(region["y"])) * area.h,
                    float(str(region["w"])) * area.w,
                    float(str(region["h"])) * area.h,
                )
            )
        for index, left in enumerate(output):
            for other in range(index):
                right = output[other]
                overlap = (
                    min(left.x + left.w, right.x + right.w) - max(left.x, right.x) > 0.01
                    and min(left.y + left.h, right.y + right.h) - max(left.y, right.y) > 0.01
                )
                if (
                    overlap
                    and not record(blocks[index], "组件").get("decorative")
                    and not record(blocks[other], "组件").get("decorative")
                ):
                    raise DomainError(422, "非装饰组件发生重叠，请修订区域")
        return output
    columns = (
        len(blocks)
        if layout == "process"
        else 1
        if layout == "timeline"
        else 2
        if layout in {"split", "compare"}
        else int(str(design.get("columns", 2)))
    )
    columns = min(columns, len(blocks))
    rows = math.ceil(len(blocks) / columns)
    gap = 0.22
    width, height = (area.w - gap * (columns - 1)) / columns, (area.h - gap * (rows - 1)) / rows
    return [
        Region(
            area.x + index % columns * (width + gap),
            area.y + index // columns * (height + gap),
            width,
            height,
        )
        for index in range(len(blocks))
    ]


def draw_design(
    slide: Slide,
    value: object,
    area: Region,
    theme: dict[str, object],
    images: dict[str, InputFile],
) -> None:
    """设计页组件均为原生Office对象，图片仅用于显式图片组件。"""
    design = record(value, "设计")
    blocks = [record(block, "组件") for block in sequence(design["blocks"], "组件", 16)]
    for block, region in zip(blocks, block_regions(design, area), strict=True):
        kind, identifier = block["type"], str(block["id"])
        if kind == "shape":
            native_shape(
                slide,
                str(block["shape"]),
                region,
                str(block.get("color", theme["accent"])),
                identifier,
            )
            continue
        if block.get("appearance") in {"panel", "accent"}:
            native_shape(slide, "roundRect", region, str(theme["surface"]), identifier + "_panel")
            if block["appearance"] == "accent":
                native_shape(
                    slide,
                    "rect",
                    Region(region.x, region.y, 0.06, region.h),
                    str(theme["accent"]),
                    identifier + "_accent",
                )
            region = region.inset(0.15)
        if block.get("title"):
            heading = min(0.65, region.h * 0.25)
            textbox(
                slide,
                [str(block["title"])],
                Region(region.x, region.y, region.w, heading),
                theme,
                22,
                True,
                name=identifier + "_title",
            )
            region = Region(
                region.x, region.y + heading + 0.08, region.w, region.h - heading - 0.08
            )
        caption = str(block.get("caption", ""))
        if caption:
            textbox(
                slide,
                [caption],
                Region(region.x, region.y + region.h - 0.6, region.w, 0.6),
                theme,
                14,
                foreground=str(theme["muted"]),
                name=identifier + "_caption",
            )
            region = Region(region.x, region.y, region.w, region.h - 0.7)
        if kind == "text":
            textbox(slide, str(block["text"]).splitlines(), region, theme, 22, name=identifier)
        elif kind == "metric":
            textbox(
                slide,
                [str(block["value"])],
                region,
                theme,
                46,
                True,
                str(theme["accent"]),
                identifier,
            )
        elif kind == "table":
            draw_table(slide, block["table"], region, theme)
        elif kind == "chart":
            draw_chart(slide, block["chart"], region, theme)
        elif kind == "image":
            draw_image(slide, block["imageId"], region, images)

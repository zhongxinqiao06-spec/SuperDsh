"""PPT方案、原生图表和设计组件的有界校验，保留既有方案字段。"""

import json
import re
from pathlib import Path

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import color, numeric, record, sequence, text


def theme(value: object = None) -> dict[str, object]:
    """主题默认值来自可配置资源，主题版本不会散落在渲染逻辑。"""
    defaults = json.loads(
        (Path(__file__).parents[2] / "resources/extensions/presentation-themes.json").read_text(
            encoding="utf-8"
        )
    )
    result = record(defaults[0], "默认设计主题")
    custom = record(value or {}, "设计主题", set(result))
    for key, item in custom.items():
        if key in {"background", "foreground", "accent", "secondary", "surface", "muted"}:
            result[key] = color(item)
        elif key == "density":
            if item not in {"comfortable", "compact"}:
                raise DomainError(422, "设计密度无效")
            result[key] = item
        else:
            label = text(item, "主题属性", 100)
            if re.search(r"[<>\\/]", label):
                raise DomainError(422, "主题属性不能包含路径或标记")
            result[key] = label
    return result


def region(value: object, normalized: bool = False) -> dict[str, float]:
    """设计区域是正文比例；模板区域是英寸，不能混用坐标系。"""
    item = record(value, "内容区域", {"x", "y", "w", "h"})
    output = {key: numeric(item.get(key), "区域坐标") for key in ("x", "y", "w", "h")}
    if (
        output["x"] < 0
        or output["y"] < 0
        or output["w"] <= 0
        or output["h"] <= 0
        or normalized
        and (output["x"] + output["w"] > 1.00001 or output["y"] + output["h"] > 1.00001)
    ):
        raise DomainError(422, "内容区域越界或无正尺寸")
    return output


def table(value: object) -> dict[str, object]:
    """演示表格限制文字密度，不截断数据来伪造可读结果。"""
    item = record(value, "表格", {"columns", "rows"})
    columns = [text(name, "表头", 80) for name in sequence(item.get("columns"), "表头", 8, 1)]
    rows = [
        [
            numeric(cell, "数值")
            if isinstance(cell, (int, float)) and not isinstance(cell, bool)
            else text(cell, "单元格", 200, True)
            for cell in sequence(row, "表格行", len(columns), len(columns))
        ]
        for row in sequence(item.get("rows"), "表格行", 15, 1)
    ]
    return {"columns": columns, "rows": rows}


def chart(value: object) -> dict[str, object]:
    """图表保存原生数据系列，禁止饼图负数和分类错位。"""
    item = record(value, "图表", {"type", "categories", "series", "valueUnit"})
    if item.get("type") not in {"bar", "line", "pie"}:
        raise DomainError(422, "图表类型不受支持")
    categories = [
        text(label, "分类", 60) for label in sequence(item.get("categories"), "分类", 24, 1)
    ]
    series: list[dict[str, object]] = []
    for raw in sequence(item.get("series"), "系列", 6, 1):
        item_series = record(raw, "系列", {"name", "values"})
        values = [
            numeric(cell, "图表数据")
            for cell in sequence(
                item_series.get("values"), "系列数据", len(categories), len(categories)
            )
        ]
        if item["type"] == "pie" and (any(value < 0 for value in values) or sum(values) <= 0):
            raise DomainError(422, "饼图数据不能为负且总和应大于零")
        series.append({"name": text(item_series.get("name"), "系列名称", 80), "values": values})
    if item["type"] == "pie" and len(series) != 1:
        raise DomainError(422, "饼图只允许一个系列")
    return {
        "type": item["type"],
        "categories": categories,
        "series": series,
        **({"valueUnit": text(item["valueUnit"], "单位", 40)} if "valueUnit" in item else {}),
    }


def design(value: object) -> dict[str, object]:
    """布局组件保持可编辑且标识唯一；canvas必须明确比例区域。"""
    item = record(value, "页面设计", {"layout", "columns", "blocks"})
    layout = item.get("layout")
    if layout not in {"split", "grid", "process", "timeline", "compare", "canvas"} or item.get(
        "columns", 2
    ) not in {2, 3}:
        raise DomainError(422, "设计布局或列数无效")
    blocks: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in sequence(item.get("blocks"), "设计组件", 16 if layout == "canvas" else 6, 1):
        block = record(
            raw,
            "组件",
            {
                "id",
                "type",
                "title",
                "text",
                "value",
                "caption",
                "imageId",
                "table",
                "chart",
                "shape",
                "color",
                "decorative",
                "appearance",
                "region",
            },
        )
        identifier = text(block.get("id"), "组件标识", 80)
        kind = block.get("type")
        if identifier in seen or kind not in {"text", "metric", "image", "table", "chart", "shape"}:
            raise DomainError(422, "组件标识重复或类型无效")
        seen.add(identifier)
        result: dict[str, object] = {"id": identifier, "type": kind}
        for key, maximum in {
            "title": 100,
            "text": 1800,
            "value": 24,
            "caption": 300,
            "imageId": 200,
        }.items():
            if key in block:
                result[key] = text(block[key], "组件" + key, maximum)
        required = {"text": "text", "metric": "value", "image": "imageId"}.get(str(kind))
        if required and required not in result:
            raise DomainError(422, "组件缺少必要内容")
        if kind == "table":
            result["table"] = table(block.get("table"))
        elif kind == "chart":
            result["chart"] = chart(block.get("chart"))
        elif kind == "shape":
            if block.get("shape") not in {
                "rect",
                "roundRect",
                "ellipse",
                "line",
                "chevron",
                "rightArrow",
            }:
                raise DomainError(422, "原生形状不受支持")
            result["shape"], result["decorative"] = block["shape"], block.get("decorative") is True
        elif block.get("decorative"):
            raise DomainError(422, "仅形状可标注装饰叠放")
        appearance = block.get("appearance", "plain")
        if appearance not in {"plain", "panel", "accent"}:
            raise DomainError(422, "组件外观无效")
        result["appearance"] = appearance
        if "color" in block:
            result["color"] = color(block["color"])
        if "region" in block:
            result["region"] = region(block["region"], True)
        elif layout == "canvas":
            raise DomainError(422, "canvas每个组件需指定区域")
        blocks.append(result)
    return {"layout": layout, "columns": item.get("columns", 2), "blocks": blocks}


def presentation_plan(value: object) -> dict[str, object]:
    """冻结完整PPT方案；未知业务字段不会被悄悄忽略。"""
    item = record(
        value, "PPT方案", {"title", "audience", "purpose", "designTheme", "brand", "slides"}
    )
    result: dict[str, object] = {
        "title": text(item.get("title"), "标题", 120),
        "designTheme": theme(item.get("designTheme")),
    }
    for key, maximum in {"audience": 200, "purpose": 500}.items():
        if key in item:
            result[key] = text(item[key], key, maximum)
    brand = record(
        item.get("brand", {}),
        "品牌",
        {"company", "fontFace", "accentColor", "textColor", "backgroundColor"},
    )
    result["brand"] = {
        key: color(value) if key.endswith("Color") else text(value, "品牌", 80)
        for key, value in brand.items()
    }
    slides: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in sequence(item.get("slides"), "幻灯片", 20, 1):
        slide = record(
            raw,
            "幻灯片",
            {
                "id",
                "kind",
                "design",
                "title",
                "body",
                "table",
                "chart",
                "imageId",
                "notes",
                "sourceIds",
                "template",
            },
        )
        identifier, kind = text(slide.get("id"), "页面标识", 100), slide.get("kind")
        if identifier in seen or kind not in {
            "title",
            "content",
            "table",
            "chart",
            "image",
            "design",
        }:
            raise DomainError(422, "页面标识重复或类型无效")
        seen.add(identifier)
        parsed: dict[str, object] = {
            "id": identifier,
            "kind": kind,
            "title": text(slide.get("title"), "页面标题", 120),
        }
        for key, maximum in {"notes": 4000, "imageId": 200}.items():
            if key in slide:
                parsed[key] = text(slide[key], key, maximum)
        if "body" in slide:
            parsed["body"] = [
                text(line, "正文", 600) for line in sequence(slide["body"], "正文", 12, 1)
            ]
        if (
            kind == "content"
            and not parsed.get("body")
            or kind == "image"
            and not parsed.get("imageId")
        ):
            raise DomainError(422, "页面缺少必要正文或图片")
        if "sourceIds" in slide:
            parsed["sourceIds"] = [
                text(source, "来源标识", 200) for source in sequence(slide["sourceIds"], "来源", 50)
            ]
        if kind == "design":
            if parsed.get("body"):
                raise DomainError(422, "设计页正文应放入组件")
            parsed["design"] = design(slide.get("design"))
        elif kind == "table":
            parsed["table"] = table(slide.get("table"))
        elif kind == "chart":
            parsed["chart"] = chart(slide.get("chart"))
        for key in ("table", "chart", "imageId", "design"):
            if key in slide and key != ("imageId" if kind == "image" else kind):
                raise DomainError(422, "页面含不匹配类型的内容")
        if "template" in slide:
            mapping = record(
                slide["template"], "模板映射", {"slide", "titleShape", "bodyShape", "contentRegion"}
            )
            number = mapping.get("slide")
            if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number <= 20:
                raise DomainError(422, "模板页码无效")
            parsed_mapping: dict[str, object] = {"slide": number}
            for key in ("titleShape", "bodyShape"):
                if key in mapping:
                    parsed_mapping[key] = text(mapping[key], "模板形状", 200)
            if "contentRegion" in mapping:
                parsed_mapping["contentRegion"] = region(mapping["contentRegion"])
            parsed["template"] = parsed_mapping
        slides.append(parsed)
    result["slides"] = slides
    return result

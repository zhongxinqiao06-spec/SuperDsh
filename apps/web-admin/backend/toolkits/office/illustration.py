"""受限结构化配图渲染；只使用原生图形与文字，不执行SVG或外部脚本。"""

import io
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Artifact, record, safe_filename, sequence, text
from toolkits.office.presentation_plan import theme


def illustration_plan(value: object) -> dict[str, object]:
    """流程/组织关系校验环路、单根和层级，指标文字原样保存。"""
    plan = record(value, "配图方案", {"title", "purpose", "layout", "nodes", "designTheme"})
    if plan.get("layout") not in {"flow", "timeline", "organization", "compare", "metrics"}:
        raise DomainError(422, "配图布局无效")
    nodes: list[dict[str, object]] = []
    seen: set[str] = set()
    for value in sequence(plan.get("nodes"), "配图节点", 9, 2):
        node = record(value, "节点", {"id", "title", "detail", "value", "parentId"})
        identifier = text(node.get("id"), "节点ID", 80)
        if identifier in seen:
            raise DomainError(422, "节点ID重复")
        seen.add(identifier)
        parsed: dict[str, object] = {
            "id": identifier,
            "title": text(node.get("title"), "节点标题", 45),
        }
        for key, length in {"detail": 220, "value": 24, "parentId": 80}.items():
            if key in node:
                parsed[key] = text(node[key], key, length)
        if plan["layout"] == "metrics" and "value" not in parsed:
            raise DomainError(422, "指标节点必须明确给出值")
        nodes.append(parsed)
    if plan["layout"] == "organization":
        mapping = {str(node["id"]): node for node in nodes}
        if sum("parentId" not in node for node in nodes) != 1:
            raise DomainError(422, "组织图需要唯一根节点")
        for node in nodes:
            visited: set[str] = set()
            cursor = node
            while True:
                identifier = str(cursor["id"])
                if identifier in visited or len(visited) >= 3:
                    raise DomainError(422, "组织图存在环路或超过三层")
                visited.add(identifier)
                if "parentId" not in cursor:
                    break
                parent = mapping.get(str(cursor["parentId"]))
                if parent is None:
                    raise DomainError(422, "组织图父节点不存在")
                cursor = parent
    elif any("parentId" in node for node in nodes):
        raise DomainError(422, "仅组织图可声明父节点")
    return {
        "title": text(plan.get("title"), "配图标题", 100),
        "purpose": text(plan["purpose"], "目的", 300, empty=True) if "purpose" in plan else "",
        "layout": plan["layout"],
        "nodes": nodes,
        "designTheme": theme(plan.get("designTheme")),
    }


def _font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    raise DomainError(503, "结构化配图需要Noto Sans CJK或微软雅黑字体")


def _wrap(
    draw: ImageDraw.ImageDraw, value: str, font: ImageFont.FreeTypeFont, width: float
) -> list[str]:
    lines: list[str] = []
    line = ""
    for character in value:
        if character == "\n" or draw.textlength(line + character, font=font) > width:
            lines.append(line)
            line = "" if character == "\n" else character
        else:
            line += character
    if line:
        lines.append(line)
    return lines


def _text(
    draw: ImageDraw.ImageDraw,
    value: str,
    box: tuple[float, float, float, float],
    fill: str,
    size: int,
    minimum: int = 18,
) -> None:
    left, top, width, height = box
    for current in range(size, minimum - 1, -1):
        font = _font(current)
        lines = _wrap(draw, value, font, width)
        if len(lines) * current * 1.4 <= height:
            for index, line in enumerate(lines):
                draw.text((left, top + index * current * 1.4), line, font=font, fill="#" + fill)
            return
    raise DomainError(422, "配图文字过密，请缩短节点文字或拆图")


def create_illustration(value: object) -> Artifact:
    """输出1600×900真实PNG和原始结构，精确数据表仍交给可编辑Office对象。"""
    plan = illustration_plan(value)
    style = record(plan["designTheme"], "主题")
    nodes = [record(node, "节点") for node in sequence(plan["nodes"], "节点", 9)]
    image = Image.new("RGB", (1600, 900), "#" + str(style["background"]))
    draw = ImageDraw.Draw(image)
    _text(draw, str(plan["title"]), (70, 40, 1460, 90), str(style["foreground"]), 46)
    boxes: dict[str, tuple[float, float, float, float]] = {}
    layout = plan["layout"]
    if layout == "organization":
        mapping = {str(node["id"]): node for node in nodes}
        levels: dict[int, list[dict[str, object]]] = {}
        for node in nodes:
            level, cursor = 0, node
            while "parentId" in cursor:
                level += 1
                cursor = mapping[str(cursor["parentId"])]
            levels.setdefault(level, []).append(node)
        for level, items in levels.items():
            width = min(450, (1460 - (len(items) - 1) * 24) / len(items))
            start = (1600 - (width * len(items) + 24 * (len(items) - 1))) / 2
            for index, node in enumerate(items):
                boxes[str(node["id"])] = (
                    start + index * (width + 24),
                    160 + level * 225,
                    width,
                    190,
                )
        for node in nodes:
            if "parentId" in node:
                x, y, w, h = boxes[str(node["id"])]
                px, py, pw, ph = boxes[str(node["parentId"])]
                draw.line(
                    [(px + pw / 2, py + ph), (x + w / 2, y)],
                    fill="#" + str(style["secondary"]),
                    width=5,
                )
    else:
        columns = min(3, len(nodes)) if layout in {"metrics", "flow"} else 2
        rows = math.ceil(len(nodes) / columns)
        width, height = (1460 - (columns - 1) * 30) / columns, (670 - (rows - 1) * 30) / rows
        for index, node in enumerate(nodes):
            boxes[str(node["id"])] = (
                70 + index % columns * (width + 30),
                160 + index // columns * (height + 30),
                width,
                height,
            )
        if layout in {"flow", "timeline"}:
            for index in range(len(nodes) - 1):
                x, y, w, h = boxes[str(nodes[index]["id"])]
                nx, ny, nw, nh = boxes[str(nodes[index + 1]["id"])]
                if y == ny:
                    middle = y + h / 2
                    draw.line(
                        [(x + w, middle), (nx - 5, middle)],
                        fill="#" + str(style["secondary"]),
                        width=4,
                    )
                    draw.polygon(
                        [(nx - 5, middle), (nx - 14, middle - 7), (nx - 14, middle + 7)],
                        fill="#" + str(style["secondary"]),
                    )
                else:
                    # 跨行用行间留白连接，不让流程在换行处断开或穿过下一行正文。
                    start_x, target_x = x + w / 2, nx + nw / 2
                    gap_y = (y + h + ny) / 2
                    draw.line(
                        [(start_x, y + h), (start_x, gap_y), (target_x, gap_y), (target_x, ny - 5)],
                        fill="#" + str(style["secondary"]),
                        width=4,
                    )
                    draw.polygon(
                        [(target_x, ny - 5), (target_x - 7, ny - 14), (target_x + 7, ny - 14)],
                        fill="#" + str(style["secondary"]),
                    )
    for index, node in enumerate(nodes):
        x, y, w, h = boxes[str(node["id"])]
        draw.rounded_rectangle((x, y, x + w, y + h), radius=18, fill="#" + str(style["surface"]))
        draw.rectangle((x, y + 18, x + 5, y + h - 18), fill="#" + str(style["accent"]))
        title = (str(index + 1) + ". " if layout in {"flow", "timeline"} else "") + str(
            node["title"]
        )
        heading_height = min(80, h * 0.35)
        _text(draw, title, (x + 24, y + 18, w - 48, heading_height), str(style["foreground"]), 30)
        body = (
            str(node.get("value", ""))
            + ("\n" if node.get("value") and node.get("detail") else "")
            + str(node.get("detail", ""))
        )
        if body:
            _text(
                draw,
                body,
                (x + 24, y + 22 + heading_height, w - 48, h - heading_height - 40),
                str(style["accent"] if layout == "metrics" else style["muted"]),
                42 if layout == "metrics" else 23,
            )
    output = io.BytesIO()
    image.save(output, "PNG")
    return Artifact(
        safe_filename(plan["title"], ".png"),
        output.getvalue(),
        "image/png",
        plan,
        {
            "plan": plan,
            "width": 1600,
            "height": 900,
            "renderedQuality": {
                "status": "passed",
                "renderer": "pillow",
                "boundsChecked": True,
                "visualModelReviewed": False,
            },
        },
    )

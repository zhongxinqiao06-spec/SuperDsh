"""为《作手噜噜》验收作品绘制明确标注的模拟交易画面，不请求模型或接触真实行情。"""

import argparse
import json
import subprocess
from importlib import import_module
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 720, 1280
BG, PANEL, INK, MUTED = "#101b29", "#192b3d", "#f3f5f7", "#9fb2c5"
ORANGE, RED, GREEN = "#ffc179", "#ff7885", "#59d4b3"
FONTS = {
    size: ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", size) for size in (18, 22, 26, 30, 38, 44)
}


def text(
    draw: ImageDraw.ImageDraw, xy: tuple, value: str, size: int = 26, color: str = INK
) -> None:
    draw.text(xy, value, font=FONTS[size], fill=color)


def wrapped(
    draw: ImageDraw.ImageDraw,
    xy: tuple,
    value: str,
    size: int = 26,
    width: int = 590,
    color: str = INK,
) -> None:
    x, y = xy
    line = ""
    for char in value:
        if char == "\n" or draw.textlength(line + char, font=FONTS[size]) > width:
            text(draw, (x, y), line, size, color)
            y += size * 1.6
            line = "" if char == "\n" else char
        else:
            line += char
    if line:
        text(draw, (x, y), line, size, color)


def card(
    draw: ImageDraw.ImageDraw, y: int, label: str, detail: str, index: int, progress: float
) -> None:
    draw.rounded_rectangle((64, y, 656, y + 118), 16, fill="#233a50", outline="#355169")
    if progress * 4 >= index:
        text(draw, (88, y + 15), label, 30, ORANGE)
        wrapped(draw, (88, y + 60), detail, 22, 540, INK)
    else:
        text(draw, (88, y + 35), "· · ·", 30, MUTED)


def candles(draw: ImageDraw.ImageDraw, kind: str, progress: float) -> None:
    values = [
        112,
        110,
        108,
        109,
        105,
        103,
        100,
        98,
        96,
        95,
        94,
        96,
        97,
        101,
        103,
        99,
        96,
        98,
        102,
        105,
        107,
        108,
    ]
    left, right, bottom = 84, 638, 770
    for i in range(5):
        y = bottom - (116 - i * 7 - 88) * 14
        draw.line((left, y, right, y), fill="#30485c", width=1)
        text(draw, (89, y + 3), str(116 - i * 7), 18, MUTED)
    count = min(len(values), 4 + int(progress * (len(values) - 4)))
    if kind == "candles":
        count = min(12, count)
    for i in range(count):
        opening = values[i - 1] if i else 114
        closing = values[i]
        x = left + 8 + i * 24
        oy, cy = bottom - (opening - 88) * 14, bottom - (closing - 88) * 14
        color = RED if closing >= opening else GREEN
        draw.line((x, min(oy, cy) - 13, x, max(oy, cy) + 15), fill=color, width=2)
        draw.rectangle((x - 7, min(oy, cy), x + 7, max(oy, cy) + 2), fill=color)
    if kind == "candles":
        draw.rounded_rectangle((383, 400, 632, 700), 14, fill="#26394a")
        text(draw, (414, 490), "未来未知", 38, ORANGE)
        text(draw, (412, 552), "不能偷看右边", 22, MUTED)
    else:
        line_y = bottom - (102 - 88) * 14
        draw.line((left, line_y, right, line_y), fill=ORANGE, width=2)
        text(draw, (90, 315), "观察线（教学示意）", 22, ORANGE)
        if kind == "left":
            x = left + 8 + 9 * 24
            text(draw, (x - 50, 783), "确认前", 22, ORANGE)
        elif kind == "right":
            text(draw, (440, 783), "等待条件", 22, ORANGE)
        elif kind == "false":
            text(draw, (354, 783), "越线后又回落", 22, ORANGE)
        else:
            text(draw, (100, 783), "拐点不等于事先可知", 22, ORANGE)


def diagram(draw: ImageDraw.ImageDraw, kind: str, progress: float) -> None:
    data = {
        "compare": [
            ("左侧", "趋势确认前，按判断布局"),
            ("右侧", "等待预先写明的触发条件"),
            ("共同点", "都可能失败；先有风险安排"),
        ],
        "horizon": [
            ("短线", "较短持有；关注短期变化"),
            ("中线 / 长线", "更长观察期；仍需复核依据"),
            ("波段 / 定投 / 做T", "是做法；不等于统一的持有天数"),
        ],
        "inventory": [
            ("原有底仓", "100 股可卖"),
            ("今天买入", "+100 股；这部分今天不可卖"),
            ("今天可卖", "仍为原有的 100 股"),
        ],
        "cost": [
            ("看到的价差", "不等于最终净收益"),
            ("要扣除", "交易费用；具体按品种与账户核对"),
            ("还可能", "卖后继续涨 / 买后继续跌"),
        ],
        "dca": [
            ("第 1 期 · 固定 100 元", "模拟单价 10 元 → 10 份"),
            ("第 2 期 · 固定 100 元", "模拟单价 5 元 → 20 份"),
            ("第 3 期 · 固定 100 元", "模拟单价 20 元 → 5 份"),
        ],
        "checklist": [
            ("01 这笔钱放多久？", "先确定时间安排"),
            ("02 为什么现在做？", "写清自己的判断依据"),
            ("03 如果判断错了？", "考虑仓位、退出与承受能力"),
        ],
        "markets": [("A 股", "中国内地市场"), ("美股", "美国市场"), ("韩股", "韩国市场")],
        "channels": [
            ("利率预期", "资金成本与估值"),
            ("汇率变化", "跨币种收益换算"),
            ("产业联系", "同一消息，影响不同环节"),
        ],
        "local": [
            ("当地政策与预期", "每个市场都有自身条件"),
            ("行业与公司盈利", "行业权重、经营情况各不相同"),
            ("资金与投资者", "风险偏好和反应节奏并非一致"),
        ],
        "clock": [
            ("时间", "交易时段、休市日、消息发布时间"),
            ("币种", "本币收益与换算收益不同"),
            ("指标", "指数、个股、区间不能随意混比"),
        ],
    }
    if kind == "divergence":
        colors = [ORANGE, "#a99bff", GREEN]
        names = ["模拟 A 股", "模拟美股", "模拟韩股"]
        paths = [
            [0, 1, 2, 1, 0, -2, -1, 1, 0],
            [0, 2, 1, 3, 4, 2, 3, 5, 4],
            [0, -1, 0, 0, 1, 2, 1, 0, -1],
        ]
        draw.line((90, 630, 635, 630), fill="#40566b", width=2)
        text(draw, (90, 655), "基点 100", 22, MUTED)
        for k, vals in enumerate(paths):
            text(draw, (90, 340 + k * 45), names[k], 26, colors[k])
            count = max(2, min(len(vals), int(progress * 9) + 1))
            coords = [(100 + i * 64, 630 - v * 26) for i, v in enumerate(vals[:count])]
            draw.line(coords, fill=colors[k], width=5)
        return
    for i, (label, detail) in enumerate(data[kind]):
        card(draw, 332 + i * 150, label, detail, i, progress)
    if kind == "dca":
        wrapped(
            draw, (88, 810), "可分份额标的的简化示意，未计费用；不是股票委托示例。", 22, 540, MUTED
        )


def frame(episode: dict, shot: list, progress: float) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    text(draw, (48, 46), "作手噜噜  /  模拟交易台", 26, ORANGE)
    text(draw, (48, 99), f"第 {episode['n']} 集  ·  教学演示", 22, MUTED)
    wrapped(draw, (48, 158), shot[2], 38, 624)
    draw.rounded_rectangle((44, 284, 676, 872), 24, fill=PANEL)
    kind = shot[1]
    if kind in ("candles", "left", "right", "false", "swing"):
        candles(draw, kind, progress)
    else:
        diagram(draw, kind, progress)
    draw.rounded_rectangle((44, 902, 676, 1040), 20, fill="#2b3843")
    wrapped(draw, (68, 930), shot[4], 30, 582, ORANGE)
    text(draw, (48, 1081), "虚构模拟数据  ·  非实盘  ·  非投资建议", 22, MUTED)
    draw.rounded_rectangle((48, 1235, 672, 1240), 2, fill="#344456")
    draw.rounded_rectangle((48, 1235, 48 + max(1, 624 * progress), 1240), 2, fill=ORANGE)
    return image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("script", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for episode in json.loads(args.script.read_text(encoding="utf-8")):
        for index, shot in enumerate(episode["shots"]):
            if shot[1] == "actor":
                continue
            name = f"ep{episode['n']}-s{index + 1:02}"
            target = args.output / (name + ".mp4")
            if target.exists():
                continue
            frame(episode, shot, 1).save(args.output / (name + ".png"))
            command = [
                str(import_module("imageio_ffmpeg").get_ffmpeg_exe()),
                "-y",
                "-loglevel",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                f"{WIDTH}x{HEIGHT}",
                "-r",
                "10",
                "-i",
                "-",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-threads",
                "2",
                "-pix_fmt",
                "yuv420p",
                "-r",
                "25",
                "-movflags",
                "+faststart",
                str(target),
            ]
            process = subprocess.Popen(command, stdin=subprocess.PIPE)
            assert process.stdin is not None
            try:
                for i in range(shot[0] * 10):
                    image = frame(episode, shot, min(1, i / max(1, shot[0] * 7)))
                    process.stdin.write(image.tobytes())
                process.stdin.close()
                if process.wait(timeout=60):
                    raise RuntimeError(f"画面编码失败：{name}")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            print(name, flush=True)


if __name__ == "__main__":
    main()

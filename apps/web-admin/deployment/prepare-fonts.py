"""构建期从发行版 CJK 集合提取简体中文独立字体，运行镜像不依赖字体处理工具。"""

import argparse
from pathlib import Path

from fontTools.ttLib import TTCollection


def prepare(source: Path, destination: Path) -> None:
    """按字体自身 family 元数据选择，不假设 TTC 的 SC face 永远处于固定索引。"""
    destination.mkdir(parents=True, exist_ok=True)
    required = {"Noto Sans CJK SC", "Noto Serif CJK SC"}
    produced: set[tuple[str, str]] = set()
    for archive in sorted(source.glob("*.ttc")):
        with TTCollection(
            archive, recalcTimestamp=False, recalcBBoxes=False
        ) as collection:
            for font in collection.fonts:
                names = font["name"]
                family = names.getDebugName(16) or names.getDebugName(1)
                if family not in required:
                    continue
                style = names.getDebugName(17) or names.getDebugName(2)
                postscript = names.getDebugName(6)
                if not postscript or not all(
                    character.isalnum() or character in "-_" for character in postscript
                ):
                    raise ValueError("字体缺少安全的 PostScript 身份")
                if (family, style) in produced:
                    raise ValueError("重复字体身份，拒绝依赖扫描顺序")
                # Noto 的集合共享 CFF 字形程序，CFF 名称可能仍是集合首个 JP face。
                # 为兼容 LibreOffice，将 CFF 名称与所选 SC face 的 name 表对齐；不更改
                # cmap/GSUB 或轮廓，保留原简体字符映射及字形替换，而非修改验收规则。
                if "CFF " in font:
                    cff = font["CFF "].cff
                    if len(cff.fontNames) != 1:
                        raise ValueError("无法安全规范化多字库 CFF 名称")
                    original = cff.fontNames[0]
                    print(f"字体身份规范化：{original} -> {postscript}")
                    cff.fontNames = [postscript]
                    top = cff.topDictIndex[0]
                    top.FullName = names.getDebugName(4) or postscript
                    top.FamilyName = family
                    # PDF 子集可能采用 CID Font DICT 的 VKana/Alphabetic 子字体名称。
                    # 只替换同一字库的族名前缀，保留子字体身份和全部字形数据。
                    for dictionary in getattr(top, "FDArray", []):
                        name = getattr(dictionary, "FontName", "")
                        if name.startswith(original):
                            dictionary.FontName = postscript + name[len(original) :]
                suffix = ".otf" if font.sfntVersion == "OTTO" else ".ttf"
                font.save(destination / (postscript + suffix))
                produced.add((family, style))
    if any(
        (family, style) not in produced
        for family in required
        for style in ("Regular", "Bold")
    ):
        raise ValueError("简体中文字体缺少 Regular/Bold，不能生成不完整运行镜像")
    print(
        "已生成独立简体中文字体："
        + ", ".join(f"{family} {style}" for family, style in sorted(produced))
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    options = parser.parse_args()
    prepare(options.source, options.destination)

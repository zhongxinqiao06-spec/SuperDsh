"""把确认方案、计算口径、输入摘要和异常一并写入可编辑成果。"""

import json
import math
import unicodedata

from openpyxl.styles import Alignment, Font
from openpyxl.utils.cell import get_column_letter
from openpyxl.worksheet.page import PageMargins
from openpyxl.worksheet.worksheet import Worksheet

from toolkits.office.contracts import InputFile


def _wrapped_lines(value: object, width: float) -> int:
    """按当前11磅中文字体保守估算折行；Calc不会替未指定高度的行自动扩容。"""
    return sum(
        max(
            1,
            math.ceil(
                sum(
                    2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
                    for character in line
                )
                / (width - 4)
            ),
        )
        for line in str(value or "").split("\n")
    )


def write_provenance(
    sheet: Worksheet,
    plan: dict[str, object],
    inputs: list[InputFile],
    template: InputFile | None,
    issues: list[dict[str, object]],
) -> None:
    """沿用既有来源与异常表契约；空输入也保留方案和检查结果，不能生成空白证明页。"""
    # 保留既有纵向纸张及横向分页；说明列本身必须能落入一个打印页，避免整列越界。
    for column, width in zip(("A", "B", "C"), (20, 38, 60), strict=True):
        sheet.column_dimensions[column].width = width
    sheet.append(["类别", "位置", "说明"])
    sheet.append(
        ["方案", str(plan["title"]), json.dumps(plan, ensure_ascii=False, separators=(",", ":"))]
    )
    sheet.append(
        [
            "计算口径",
            "数值",
            "采用十进制有理数计算；最终数值最多保留 12 位小数，金额小数位以确认方案 ROUND 为准。原始记录按行保留，订单数请明确使用 countDistinct。",
        ]
    )
    for source in inputs:
        sheet.append(["输入来源", source.filename, "SHA-256 " + source.sha256])
    if template:
        sheet.append(
            ["模板", template.filename, "已有工作表、支持的公式和样式保留，新增结果表，不覆盖原表"]
        )
    for issue in issues:
        location = str(issue.get("tableId", ""))
        if issue.get("row"):
            location += f" / 第 {issue['row']} 行"
        sheet.append([str(issue.get("code", "")), location, str(issue.get("message", ""))])
    if not issues:
        sheet.append(["检查", "通过", "未发现需报告的数据异常"])
    for row_index, row in enumerate(sheet, 1):
        for cell in row:
            cell.font = Font(name="Noto Sans CJK SC", size=11, bold=cell.row == 1)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            # 方案和来源都是普通字符串，即使文件名以等号开头也不执行公式。
            if isinstance(cell.value, str):
                cell.data_type = "s"
        # 只缩列会把方案JSON及计算口径裁成一行，必须同步保留全部折行的可见高度。
        lines = max(
            _wrapped_lines(cell.value, sheet.column_dimensions[get_column_letter(column)].width)
            for column, cell in enumerate(row, 1)
        )
        sheet.row_dimensions[row_index].height = lines * 17 + 8
    sheet.page_margins = PageMargins(
        left=0.7, right=0.7, top=0.75, bottom=0.75, header=0.3, footer=0.3
    )
    sheet.page_setup.orientation = "portrait"
    sheet.page_setup.scale = 100

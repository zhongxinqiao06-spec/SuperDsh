"""读取CSV/XLSX物理行并重算输入公式，保留来源位置和摘要。"""

import csv
import io
import math
import re
from datetime import date, datetime

from openpyxl import load_workbook

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Cell, InputFile, office_archive, record, sequence, text
from toolkits.office.formula_import import FormulaWorkbook
from toolkits.office.spreadsheet_values import Table


def cell_value(value: object) -> Cell:
    """单元格只保留可验证的标量，不把对象字符串化混入数据。"""
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        if (
            isinstance(value, str)
            and len(value) > 4000
            or isinstance(value, float)
            and not math.isfinite(value)
        ):
            raise DomainError(422, "单元格内容超限")
        return value
    raise DomainError(422, "单元格类型不受支持")


def table_from_rows(
    file: InputFile, index: int, sheet: str, rows: list[list[Cell]], selection: dict[str, object]
) -> Table:
    """表头使用一基物理行；重复或空表头需要用户明确映射/选择。"""
    header = selection.get("headerRow", 1)
    if not isinstance(header, int) or isinstance(header, bool) or not 1 <= header <= len(rows):
        raise DomainError(422, "表头行超出资料范围")
    width = max((len(row) for row in rows), default=0)
    if width > 64 or len(rows) - header > 5000 or width == 0:
        raise DomainError(422, "输入表格超过5000行/64列或为空")
    columns = [text(value, "表头", 100) for value in rows[header - 1]]
    if len(columns) != width or len(set(columns)) != width:
        raise DomainError(422, "表头含空值或重复，请明确选择表头行")
    mapping = record(selection.get("mapping", {}), "表头映射")
    if any(key not in columns for key in mapping):
        raise DomainError(422, "表头映射包含不存在的字段")
    columns = [text(mapping.get(name, name), "字段", 100) for name in columns]
    if len(set(columns)) != len(columns):
        raise DomainError(422, "映射后字段重复")
    data: list[list[Cell]] = []
    row_numbers: list[int] = []
    for position, row in enumerate(rows[header:], header + 1):
        if any(value is not None and value != "" for value in row):
            data.append(row + [None] * (width - len(row)))
            row_numbers.append(position)
    return Table(
        f"{index}:{sheet}", columns, data, row_numbers, index, file.filename, sheet, header
    )


def read_tables(
    inputs: list[InputFile], selections: object = None, allow_value_extraction: bool = False
) -> tuple[dict[str, Table], list[dict[str, object]]]:
    """显式选择可筛掉非数据Sheet；复杂视觉对象只有明确授权才提取值。"""
    chosen = (
        [
            record(item, "输入选择", {"fileIndex", "sheet", "headerRow", "mapping"})
            for item in sequence(selections, "输入选择", 30)
        ]
        if selections is not None
        else []
    )
    for item in chosen:
        file_index = item.get("fileIndex")
        if (
            not isinstance(file_index, int)
            or isinstance(file_index, bool)
            or not 0 <= file_index < len(inputs)
        ):
            raise DomainError(422, "输入文件序号无效")
    tables: dict[str, Table] = {}
    issues: list[dict[str, object]] = []
    for index, file in enumerate(inputs):
        relevant = [item for item in chosen if item["fileIndex"] == index]
        if chosen and not relevant:
            continue
        if file.filename.lower().endswith(".csv"):
            if len(file.content) > 10 * 1024 * 1024:
                raise DomainError(413, "CSV文件过大")
            try:
                content = file.content.decode("utf-8-sig")
            except UnicodeDecodeError as error:
                raise DomainError(422, "CSV需要UTF-8编码") from error
            reader = csv.reader(io.StringIO(content))
            rows: list[list[Cell]] = []
            try:
                for row in reader:
                    if len(rows) >= 5100 or len(row) > 64:
                        raise DomainError(422, "CSV行列超过限制")
                    rows.append([cell_value(value) for value in row])
            except csv.Error as error:
                raise DomainError(422, "CSV格式无效") from error
            selection = relevant[0] if relevant else {}
            if len(relevant) > 1 or selection.get("sheet", "CSV") != "CSV":
                raise DomainError(422, "CSV只能选择CSV工作表")
            table = table_from_rows(file, index, "CSV", rows, selection)
            tables[table.id] = table
            continue
        if not file.filename.lower().endswith(".xlsx"):
            raise DomainError(422, "表格输入仅支持CSV/XLSX")
        archive = office_archive(file)
        objects = [
            name
            for name in archive
            if re.match(r"xl/(drawings|charts|pivotTables|slicers|vmlDrawings|media)/", name)
        ]
        if objects and not allow_value_extraction:
            raise DomainError(422, "输入包含图表/图片等对象，需显式允许仅提取表格值")
        if objects:
            issues.append(
                {
                    "severity": "warning",
                    "code": "value_extraction",
                    "message": "已按方案仅提取表格值，源文件视觉对象不复制",
                    "tableId": str(index),
                }
            )
        try:
            workbook = load_workbook(io.BytesIO(file.content), data_only=False, keep_links=False)
        except (ValueError, KeyError, OSError) as error:
            raise DomainError(422, "XLSX文件损坏") from error
        formulas = FormulaWorkbook(workbook)
        selected_names = {str(item["sheet"]) for item in relevant if "sheet" in item}
        if not selected_names.issubset(set(workbook.sheetnames)):
            raise DomainError(422, "选择的工作表不存在")
        try:
            for sheet in workbook.worksheets:
                if selected_names and sheet.title not in selected_names:
                    continue
                matching = [
                    item for item in relevant if item.get("sheet", sheet.title) == sheet.title
                ]
                if len(matching) > 1:
                    raise DomainError(422, "同一工作表被重复选择")
                if sheet.max_row > 5100 or sheet.max_column > 64:
                    raise DomainError(422, "工作表物理行列超过限制")
                rows = [
                    [cell_value(formulas.cell(sheet.title, cell.coordinate)) for cell in row]
                    for row in sheet.iter_rows()
                ]
                while rows and all(value is None or value == "" for value in rows[-1]):
                    rows.pop()
                if not rows:
                    continue
                table = table_from_rows(
                    file, index, sheet.title, rows, matching[0] if matching else {}
                )
                tables[table.id] = table
        finally:
            workbook.close()
    return tables, issues


def inspect_tables(
    inputs: list[InputFile], selections: object = None, allow_value_extraction: bool = False
) -> dict[str, object]:
    """返回有限样本和完整计数，不将全部业务表塞入模型上下文。"""
    tables, issues = read_tables(inputs, selections, allow_value_extraction)
    return {
        "tables": [
            {
                "id": table.id,
                "fileIndex": table.file_index,
                "filename": table.filename,
                "sheet": table.sheet,
                "headerRow": table.header_row,
                "columns": table.columns,
                "rowCount": len(table.rows),
                "sampleRows": table.rows[:8],
            }
            for table in tables.values()
        ],
        "issues": issues,
        "sources": [
            {"fileIndex": index, "filename": file.filename, "sha256": file.sha256}
            for index, file in enumerate(inputs)
        ],
    }

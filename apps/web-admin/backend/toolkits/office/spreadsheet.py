"""生成可编辑工作簿、原生公式/图表和来源记录；模板原Sheet保留后追加结果。"""

import io
import re
import zipfile
from itertools import chain
from xml.etree import ElementTree

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, TwoCellAnchor
from openpyxl.drawing.text import CharacterProperties
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils.cell import get_column_letter
from openpyxl.workbook.properties import CalcProperties
from openpyxl.worksheet.page import PageMargins
from openpyxl.worksheet.worksheet import Worksheet

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import (
    Artifact,
    Cell,
    InputFile,
    office_archive,
    record,
    safe_filename,
    sequence,
    text,
)
from toolkits.office.formula_import import FormulaWorkbook
from toolkits.office.spreadsheet_formula import compile_formula
from toolkits.office.spreadsheet_input import cell_value, read_tables
from toolkits.office.spreadsheet_operations import operations
from toolkits.office.spreadsheet_provenance import write_provenance
from toolkits.office.spreadsheet_values import Table

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _sheet_name(value: object) -> str:
    name = text(value, "工作表名称", 31)
    if re.search(r"[\\/*?:\[\]]", name) or name.startswith("'") or name.endswith("'"):
        raise DomainError(422, "工作表名称包含非法字符")
    return name


def _name(workbook: Workbook, prefix: str) -> str:
    name = prefix[:31]
    index = 1
    while name.casefold() in {item.casefold() for item in workbook.sheetnames}:
        index += 1
        name = prefix[:25] + "_" + str(index)
    return name


def _write(sheet: Worksheet, table: Table) -> None:
    rows: list[list[Cell]] = [list(table.columns), *table.rows]
    for row_index, row in enumerate(rows, 1):
        for column, value in enumerate(row, 1):
            cell = sheet.cell(row_index, column, value)
            if isinstance(value, str):
                cell.data_type = "s"
            cell.font = Font(
                name="Noto Sans CJK SC",
                size=11,
                bold=row_index == 1,
                color="FFFFFF" if row_index == 1 else "000000",
            )
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            if row_index == 1:
                cell.fill = PatternFill("solid", fgColor="183B56")
            elif row_index % 2 == 0:
                cell.fill = PatternFill("solid", fgColor="F3F6FA")
            if isinstance(value, float) and not value.is_integer():
                cell.number_format = "#,##0.00##########"
        sheet.row_dimensions[row_index].height = 28 if row_index == 1 else 24
    for index, name in enumerate(table.columns, 1):
        sheet.column_dimensions[get_column_letter(index)].width = min(
            36, max(16, len(name) * 2 + 4)
        )
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    if sheet.sheet_properties.pageSetUpPr is not None:
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape" if len(table.columns) > 6 else "portrait"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.page_margins = PageMargins(
        left=0.7, right=0.7, top=0.75, bottom=0.75, header=0.3, footer=0.3
    )


def _charts(sheet: Worksheet, table: Table, raw: object) -> None:
    for index, value in enumerate(sequence(raw, "图表", 8)):
        item = record(value, "图表", {"type", "title", "category", "values"})
        chart = {"column": BarChart, "line": LineChart, "pie": PieChart}.get(str(item.get("type")))
        if chart is None:
            raise DomainError(422, "图表类型无效")
        instance = chart()
        instance.title = text(item.get("title"), "图表标题", 120)
        if instance.title and instance.title.tx and instance.title.tx.rich:
            for paragraph in instance.title.tx.rich.p:
                for run in paragraph.r:
                    run.rPr = CharacterProperties(lang="zh-CN", sz=1600)
        columns = sequence(item.get("values"), "图表数值字段", 8, 1)
        if item["type"] == "pie" and len(columns) != 1 or not table.rows or len(table.rows) > 100:
            raise DomainError(422, "图表需1至100行；饼图只能有一个数值系列")
        for name in columns:
            column = table.column(name)
            if any(
                value is not None
                and (isinstance(value, bool) or not isinstance(value, (int, float)))
                for value in (row[column] for row in table.rows)
            ):
                raise DomainError(422, "图表系列含非数值，请先转换字段")
            instance.add_data(
                Reference(sheet, min_col=column + 1, min_row=1, max_row=len(table.rows) + 1),
                titles_from_data=True,
            )
        instance.set_categories(
            Reference(
                sheet,
                min_col=table.column(item.get("category")) + 1,
                min_row=2,
                max_row=len(table.rows) + 1,
            )
        )
        if instance.legend:
            instance.legend.position = "b"
        palette = ("2563EB", "10B981", "F59E0B", "8B5CF6", "EF4444", "06B6D4")
        for position, series in enumerate(instance.series):
            series.graphicalProperties.solidFill = palette[position % len(palette)]
            series.graphicalProperties.line.solidFill = palette[position % len(palette)]
            series.graphicalProperties.line.width = 25400
        if isinstance(instance, BarChart):
            instance.grouping = "clustered"
            instance.gapWidth = 100
        if isinstance(instance, (BarChart, LineChart)):
            instance.y_axis.numFmt = "#,##0.##"
        # 使用原合同的单元格锚点，列宽或打印缩放变化时图表与数据表一起调整。
        top = len(table.rows) + 4 + index * 22
        instance.anchor = TwoCellAnchor(
            _from=AnchorMarker(col=0, row=top), to=AnchorMarker(col=10, row=top + 20)
        )
        sheet.add_chart(instance)


def _cached(content: bytes, cached: dict[str, dict[str, Cell]]) -> bytes:
    """写入已独立计算的公式缓存；公式仍保留，Excel可继续编辑和重算。"""
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(content)) as source,
        zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        for name in source.namelist():
            data = source.read(name)
            values = cached.get(name)
            if values:
                root = ElementTree.fromstring(data)
                for cell in root.iter(NS + "c"):
                    address = cell.get("r", "")
                    if address not in values or cell.find(NS + "f") is None:
                        continue
                    value = values[address]
                    previous = cell.find(NS + "v")
                    if previous is None:
                        previous = ElementTree.SubElement(cell, NS + "v")
                    cell.set(
                        "t",
                        "b"
                        if isinstance(value, bool)
                        else "str"
                        if isinstance(value, str) or value is None
                        else "n",
                    )
                    previous.text = (
                        "1"
                        if value is True
                        else "0"
                        if value is False
                        else ""
                        if value is None
                        else str(value)
                    )
                data = ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(name, data)
    return output.getvalue()


def _recalculate(
    workbook: Workbook, content: bytes, expected: dict[str, dict[str, Cell]]
) -> tuple[bytes, int]:
    """遍历实际写入的公式，包含模板及隐藏Sheet；不信任历史缓存或展开稀疏网格。"""
    calculation = FormulaWorkbook(workbook)
    cached: dict[str, dict[str, Cell]] = {}
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        for sheet in workbook.worksheets:
            # path 在保存时由工作簿分配，不能用全部Sheet索引猜测含图表页时的文件名。
            path = sheet.path.lstrip("/")
            root = ElementTree.fromstring(archive.read(path))
            values: dict[str, Cell] = {}
            for cell in root.iter(NS + "c"):
                if cell.find(NS + "f") is None and cell.get("t") != "e":
                    continue
                address = cell.get("r", "")
                result = calculation.cell(sheet.title, address)
                if cell.find(NS + "f") is not None:
                    values[address] = result
            required = expected.get(sheet.title, {})
            if any(
                address not in values or values[address] != value
                for address, value in required.items()
            ):
                raise DomainError(422, "原生公式重算与操作结果不一致，请将公式放在筛选/变换之后")
            cached[path] = values
    return _cached(content, cached), sum(len(values) for values in cached.values())


def create_workbook(
    value: object, inputs: list[InputFile], template: InputFile | None = None
) -> Artifact:
    """方案执行有界且确定性；模板保留原工作表，生成结果不能覆盖已有Sheet。"""
    plan = record(
        value, "工作簿方案", {"title", "filename", "sources", "allowValueExtraction", "sheets"}
    )
    title = text(plan.get("title"), "标题", 160)
    if "allowValueExtraction" in plan and not isinstance(plan["allowValueExtraction"], bool):
        raise DomainError(422, "提取授权必须为布尔值")
    tables, issues = read_tables(
        inputs, plan.get("sources"), plan.get("allowValueExtraction") is True
    )
    if template:
        parts = office_archive(template)
        if not template.filename.lower().endswith(".xlsx") or any(
            re.search(
                r"(vmlDrawing|slicer|pivot|threadedComment|customXml|controls/|connections.xml)",
                name,
                re.I,
            )
            for name in parts
        ):
            raise DomainError(422, "模板含当前无法无损保留的对象")
        workbook = load_workbook(io.BytesIO(template.content), keep_links=False)
    else:
        workbook = Workbook()
        workbook.remove(workbook.worksheets[0])
    workbook.properties.title = title
    workbook.calculation = CalcProperties(calcMode="auto", fullCalcOnLoad=True)
    definitions = [
        record(item, "工作表", {"name", "source", "operations", "charts"})
        for item in sequence(plan.get("sheets"), "工作表", 20, 1)
    ]
    generated: list[tuple[Worksheet, Table]] = []
    references: dict[str, tuple[Table, str]] = {}
    expected: dict[str, dict[str, Cell]] = {}
    for definition in definitions:
        name = _sheet_name(definition.get("name"))
        if name.casefold() in {item.casefold() for item in workbook.sheetnames}:
            raise DomainError(422, "结果Sheet名称重复或覆盖模板Sheet")
        source = definition.get("source")
        if isinstance(source, str):
            original = tables.get(source)
            if original is None:
                raise DomainError(422, "数据源不存在")
        else:
            inline = record(source, "内联表格", {"columns", "rows"})
            columns = [
                text(item, "字段", 100) for item in sequence(inline.get("columns"), "字段", 64, 1)
            ]
            if len(set(columns)) != len(columns):
                raise DomainError(422, "内联表格字段重复")
            rows = [
                [cell_value(item) for item in sequence(row, "数据行", len(columns), len(columns))]
                for row in sequence(inline.get("rows"), "数据行", 5000)
            ]
            original = Table(name, columns, rows, list(range(2, len(rows) + 2)))
        table = operations(original, definition.get("operations", []), tables, issues)
        sheet = workbook.create_sheet(name)
        _write(sheet, table)
        _charts(sheet, table, definition.get("charts", []))
        generated.append((sheet, table))
        tables[name] = table
        # 保留旧方案 output:Sheet 身份，后续汇总、关联与查找能引用已生成的结果表。
        tables["output:" + name] = table
        references[name] = table, name
        references["output:" + name] = table, name
    # 原始资料保留为单独Sheet，查找公式可追踪到真实引用，而非粘贴数值冒充公式。
    for identifier, table in tables.items():
        if identifier not in references:
            name = _name(workbook, "来源_" + str(len(references) + 1))
            _write(workbook.create_sheet(name), table)
            references[identifier] = table, name
    for sheet, table in generated:
        sheet_cache: dict[str, Cell] = {}
        for name, definition in table.formulas.items():
            column = table.column(name)
            for row, values in enumerate(table.rows, 2):
                cell = sheet.cell(row, column + 1)
                cell.value = "=" + compile_formula(definition["expression"], table, row, references)
                if definition.get("numberFormat"):
                    cell.number_format = str(definition["numberFormat"])
                sheet_cache[cell.coordinate] = values[column]
        expected[sheet.title] = sheet_cache
    sources = [
        {"fileIndex": index, "filename": file.filename, "sha256": file.sha256}
        for index, file in enumerate(inputs)
    ]
    provenance = workbook.create_sheet(_name(workbook, "来源与异常"))
    write_provenance(provenance, plan, inputs, template, issues)
    output = io.BytesIO()
    try:
        workbook.save(output)
        content, formula_count = _recalculate(workbook, output.getvalue(), expected)
    finally:
        workbook.close()
    return Artifact(
        safe_filename(plan.get("filename", title), ".xlsx"),
        content,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        {
            "sheets": [
                {"name": sheet.title, "columns": table.columns, "rowCount": len(table.rows)}
                for sheet, table in generated
            ],
            "formulaCount": formula_count,
        },
        {
            "provenance": sources,
            "anomalies": issues,
            "plan": plan,
            "templateSha256": template.sha256 if template else None,
            "calculationVerified": True,
            "expectedText": list(
                dict.fromkeys(
                    str(value)
                    for _, table in generated
                    for value in chain(table.columns, chain.from_iterable(table.rows))
                    if isinstance(value, str) and value.strip()
                )
            ),
        },
    )

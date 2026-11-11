"""把受限表达式编译为原生Excel公式，引用只来自已验证列和源表。"""

from openpyxl.utils.cell import get_column_letter, quote_sheetname

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import record, sequence
from toolkits.office.spreadsheet_values import Table


def literal(value: object) -> str:
    """数据文本始终引用，不因以等号开头而执行公式。"""
    if value is None:
        return '""'
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return '"' + str(value).replace('"', '""') + '"'


def compile_formula(
    expression: object,
    table: Table,
    row: int,
    references: dict[str, tuple[Table, str]],
    depth: int = 0,
) -> str:
    """源表引用使用已分配Sheet名称，不使用模型提供的工作簿路径。"""
    if depth > 16:
        raise DomainError(422, "公式嵌套过深")
    node = record(expression, "公式")

    def nested(value: object) -> str:
        return compile_formula(value, table, row, references, depth + 1)

    def bounds(name: object, target: Table = table, sheet: str = "") -> str:
        column = get_column_letter(target.column(name) + 1)
        prefix = quote_sheetname(sheet) + "!" if sheet else ""
        return f"{prefix}${column}$2:${column}${max(2, len(target.rows) + 1)}"

    if "literal" in node:
        return literal(node["literal"])
    if "aggregate" in node:
        span = bounds(node.get("column"))
        operation = str(node["aggregate"])

        def exact_criteria(span: str) -> str:
            # COUNTIF把*和?当通配符，标识符中的原字符必须转义，不能把多个订单误并。
            return f'"="&SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({span}&"","~","~~"),"*","~*"),"?","~?")'

        where = node.get("where")
        if where:
            condition = record(where, "汇总条件")
            symbols = {
                "eq": "=",
                "ne": "<>",
                "gt": ">",
                "gte": ">=",
                "lt": "<",
                "lte": "<=",
                "empty": "=",
                "notEmpty": "<>",
            }
            operator = str(condition.get("operator"))
            criterion = (
                "*"
                + str(condition.get("value", ""))
                .replace("~", "~~")
                .replace("*", "~*")
                .replace("?", "~?")
                + "*"
                if operator == "contains"
                else symbols[operator]
                + str(condition.get("value", "") if operator not in {"empty", "notEmpty"} else "")
            )
            match = bounds(condition.get("column"))
            argument = literal(criterion)
            names = {"sum": "SUMIF", "average": "AVERAGEIF", "min": "MINIFS", "max": "MAXIFS"}
            if operation == "count":
                return f'COUNTIFS({match},{argument},{span},"<>")'
            if operation == "countDistinct":
                selected = f"(COUNTIFS({match},{exact_criteria(match)},{match},{argument})>0)"
                counts = f"COUNTIFS({span},{exact_criteria(span)},{match},{argument})"
                # 非匹配行补一作为分母，避免0/0；匹配行按同条件内重复次数加权计一。
                return f'SUMPRODUCT((({span}<>"")*{selected})/({counts}+({selected}=FALSE)))'
            function = names[operation]
            return (
                f"{function}({span},{match},{argument})"
                if operation in {"min", "max"}
                else f"{function}({match},{argument},{span})"
            )
        if operation == "countDistinct":
            return f'SUMPRODUCT(({span}<>"")/COUNTIF({span},{exact_criteria(span)}))'
        function = {
            "sum": "SUM",
            "average": "AVERAGE",
            "min": "MIN",
            "max": "MAX",
            "count": "COUNTA",
        }[operation]
        return f"{function}({span})"
    if "column" in node:
        return get_column_letter(table.column(node["column"]) + 1) + str(row)
    if "lookup" in node:
        item = record(node["lookup"], "查找")
        reference = references.get(str(item.get("table")))
        if reference is None:
            raise DomainError(422, "查找表缺少可写入的原生引用")
        target, sheet = reference
        return f"XLOOKUP({nested(item.get('value'))},{bounds(item.get('keyColumn'), target, sheet)},{bounds(item.get('returnColumn'), target, sheet)},{literal(item.get('missing'))},0)"
    if "op" in node:
        return f"({nested(node.get('left'))}{node['op']}{nested(node.get('right'))})"
    name = str(node.get("fn"))
    arguments = [nested(item) for item in sequence(node.get("args"), "函数参数", 20)]
    # ISO日期是可移植文本；DATEVALUE明确转换，避免地区格式影响重算。
    if name in {"YEAR", "MONTH", "DAY"}:
        arguments = [f"DATEVALUE({arguments[0]})"]
    if name == "DAYS":
        return f"(DATEVALUE({arguments[0]})-DATEVALUE({arguments[1]}))"
    if name == "DATE":
        return "TEXT(DATE(" + ",".join(arguments) + '),"yyyy-mm-dd")'
    return name + "(" + ",".join(arguments) + ")"

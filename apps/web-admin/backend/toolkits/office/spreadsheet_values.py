"""电子表格的精确数值、条件及受限结构化公式，不使用eval。"""

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Cell, record, sequence, text


@dataclass
class Table:
    """每张表保留来源行号，转换诊断不会把过滤后的行号当原始位置。"""

    id: str
    columns: list[str]
    rows: list[list[Cell]]
    row_numbers: list[int]
    file_index: int = -1
    filename: str = ""
    sheet: str = ""
    header_row: int = 1
    formulas: dict[str, dict[str, object]] = field(default_factory=dict)

    def column(self, name: object) -> int:
        """引用必须对应唯一现有列，不根据近似名称猜测业务字段。"""
        if name not in self.columns:
            raise DomainError(422, "缺少字段：" + str(name)[:100])
        return self.columns.index(str(name))


def decimal(value: object) -> Decimal:
    """金额计算拒绝空值/布尔值，避免把缺数据默认为零。"""
    if value is None or isinstance(value, bool) or not str(value).strip() or len(str(value)) > 50:
        raise DomainError(422, "计算需要有效数字")
    try:
        result = Decimal(str(value).strip())
    except InvalidOperation as error:
        raise DomainError(422, "计算需要有效数字") from error
    if (
        not result.is_finite()
        or abs(result) > Decimal("999999999999999")
        or abs(int(result.as_tuple().exponent)) > 20
    ):
        raise DomainError(422, "数值超出支持精度范围")
    return result


def number(value: Decimal) -> float:
    """按既有办公合同保留最多十二位小数，最后才转换为Excel数值。"""
    if not value.is_finite() or abs(value) > Decimal("999999999999999"):
        raise DomainError(422, "计算结果超出Excel精度范围")
    with localcontext() as context:
        context.prec = 60
        return float(value.quantize(Decimal("0.000000000001"), rounding=ROUND_HALF_UP))


def valid_date(value: object) -> date:
    """日期必须明确为ISO日期或日期对象，不猜测地区格式。"""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError as error:
        raise DomainError(422, "日期需为有效YYYY-MM-DD格式") from error


def condition(value: object, table: Table, row: list[Cell]) -> bool:
    """筛选操作只接受固定比较运算。"""
    item = record(value, "筛选条件", {"column", "operator", "value"})
    left, right, operator = (
        row[table.column(item.get("column"))],
        item.get("value"),
        item.get("operator"),
    )
    if operator == "empty":
        return left is None or left == ""
    if operator == "notEmpty":
        return left is not None and left != ""
    if operator == "contains":
        return str(right or "") in str(left or "")
    if operator in {"eq", "ne"}:
        same = (
            type(left) is type(right)
            and left == right
            or isinstance(left, (int, float))
            and not isinstance(left, bool)
            and isinstance(right, (int, float))
            and not isinstance(right, bool)
            and left == right
        )
        return same if operator == "eq" else not same
    if left is None or right is None:
        return False
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        a, b = decimal(left), decimal(right)
        comparison = (a > b) - (a < b)
    else:
        comparison = (str(left) > str(right)) - (str(left) < str(right))
    operations = {
        "gt": comparison > 0,
        "gte": comparison >= 0,
        "lt": comparison < 0,
        "lte": comparison <= 0,
    }
    if operator not in operations:
        raise DomainError(422, "筛选操作不受支持")
    return operations[str(operator)]


def aggregate(operation: str, values: list[Cell]) -> Cell:
    """聚合保留空值语义和精确小数，跨币种检查由操作层执行。"""
    present = [value for value in values if value is not None and value != ""]
    if operation == "count":
        return len(present)
    if operation == "countDistinct":
        return len({(type(value).__name__, str(value)) for value in present})
    if not present:
        return 0 if operation == "sum" else None
    numbers = [decimal(value) for value in present]
    with localcontext() as context:
        context.prec = 60
        if operation == "sum":
            result = sum(numbers, Decimal(0))
        elif operation == "average":
            result = sum(numbers, Decimal(0)) / len(numbers)
        elif operation == "min":
            result = min(numbers)
        elif operation == "max":
            result = max(numbers)
        else:
            raise DomainError(422, "聚合操作不受支持")
    return number(result)


def evaluate(
    expression: object, table: Table, row: list[Cell], available: dict[str, Table], depth: int = 0
) -> Cell:
    """公式是有界表达式树，不能调用外部函数或访问任意对象。"""
    if depth > 16:
        raise DomainError(422, "公式嵌套超过16层")
    node = record(
        expression,
        "公式",
        {"literal", "column", "op", "left", "right", "fn", "args", "aggregate", "where", "lookup"},
    )

    def resolve(value: object) -> Cell:
        return evaluate(value, table, row, available, depth + 1)

    if "literal" in node:
        value = node["literal"]
        if value is None or isinstance(value, (str, int, float, bool)):
            if (
                isinstance(value, str)
                and len(value) > 4000
                or isinstance(value, float)
                and not math.isfinite(value)
            ):
                raise DomainError(422, "公式常量超限")
            return value
        raise DomainError(422, "公式常量无效")
    if "aggregate" in node:
        index = table.column(node.get("column"))
        rows = [
            candidate
            for candidate in table.rows
            if "where" not in node or condition(node["where"], table, candidate)
        ]
        return aggregate(str(node["aggregate"]), [candidate[index] for candidate in rows])
    if "column" in node:
        return row[table.column(node["column"])]
    if "lookup" in node:
        lookup = record(
            node["lookup"], "查找", {"table", "keyColumn", "value", "returnColumn", "missing"}
        )
        target = available.get(str(lookup.get("table")))
        if target is None:
            raise DomainError(422, "查找表不存在或尚未生成")
        key, value = target.column(lookup.get("keyColumn")), resolve(lookup.get("value"))
        matches = [item for item in target.rows if item[key] == value]
        if len(matches) > 1:
            raise DomainError(422, "查找键不唯一，不能任取一行")
        return (
            matches[0][target.column(lookup.get("returnColumn"))]
            if matches
            else resolve({"literal": lookup.get("missing")})
        )
    if "op" in node:
        left, right, operator = resolve(node.get("left")), resolve(node.get("right")), node["op"]
        if operator in {"=", "<>", "<", "<=", ">", ">="}:
            temporary = Table("comparison", ["left"], [[left]], [1])
            return condition(
                {
                    "column": "left",
                    "operator": {
                        "=": "eq",
                        "<>": "ne",
                        "<": "lt",
                        "<=": "lte",
                        ">": "gt",
                        ">=": "gte",
                    }[str(operator)],
                    "value": right,
                },
                temporary,
                [left],
            )
        a, b = decimal(left), decimal(right)
        with localcontext() as context:
            context.prec = 60
            if operator == "+":
                result = a + b
            elif operator == "-":
                result = a - b
            elif operator == "*":
                result = a * b
            elif operator == "/" and b:
                result = a / b
            else:
                raise DomainError(422, "公式运算无效或除以零")
        return number(result)
    name = text(node.get("fn"), "公式函数", 20)
    raw = sequence(node.get("args"), "公式参数", 20)
    if name == "IF" and len(raw) == 3:
        return resolve(raw[1] if resolve(raw[0]) else raw[2])
    args = [resolve(value) for value in raw]
    if name == "ROUND" and len(args) == 2:
        digits = decimal(args[1])
        if digits != int(digits) or not -12 <= digits <= 12:
            raise DomainError(422, "ROUND位数超限")
        return number(
            decimal(args[0]).quantize(Decimal(1).scaleb(-int(digits)), rounding=ROUND_HALF_UP)
        )
    if name == "ABS" and len(args) == 1:
        return number(abs(decimal(args[0])))
    if name in {"YEAR", "MONTH", "DAY"} and len(args) == 1:
        parsed = valid_date(args[0])
        return {"YEAR": parsed.year, "MONTH": parsed.month, "DAY": parsed.day}[name]
    if name == "DATE" and len(args) == 3:
        year, month, day = (int(decimal(value)) for value in args)
        try:
            normalized_year = year + (month - 1) // 12
            normalized_month = (month - 1) % 12 + 1
            return (
                date(normalized_year, normalized_month, 1) + timedelta(days=day - 1)
            ).isoformat()
        except (ValueError, OverflowError) as error:
            raise DomainError(422, "DATE结果超出日期范围") from error
    if name == "DAYS" and len(args) == 2:
        return (valid_date(args[0]) - valid_date(args[1])).days
    if name == "CONCAT":
        joined = "".join(str(value) if value is not None else "" for value in args)
        if len(joined) > 4000:
            raise DomainError(422, "公式文本结果过长")
        return joined
    if name in {"TRIM", "UPPER", "LOWER"} and len(args) == 1:
        value = str(args[0] or "")
        return (
            " ".join(value.split())
            if name == "TRIM"
            else value.upper()
            if name == "UPPER"
            else value.lower()
        )
    raise DomainError(422, "公式函数或参数个数不受支持")

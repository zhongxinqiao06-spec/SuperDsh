"""重算受支持的输入公式，拒绝循环、外链和未经解释的旧缓存结果。"""

import re
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from openpyxl.utils.cell import range_boundaries
from openpyxl.workbook.workbook import Workbook

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Cell, record
from toolkits.office.spreadsheet_values import decimal, number, valid_date

Value = Cell | list[Cell]
FUNCTIONS = {
    "SUM",
    "AVERAGE",
    "MIN",
    "MAX",
    "COUNT",
    "COUNTA",
    "IF",
    "ROUND",
    "ABS",
    "AND",
    "OR",
    "NOT",
    "CONCAT",
    "CONCATENATE",
    "SUMIF",
    "SUMIFS",
    "AVERAGEIF",
    "COUNTIF",
    "COUNTIFS",
    "MINIFS",
    "MAXIFS",
    "SUMPRODUCT",
    "DATE",
    "DATEVALUE",
    "YEAR",
    "MONTH",
    "DAY",
    "TEXT",
    "TRIM",
    "UPPER",
    "LOWER",
    "SUBSTITUTE",
    "XLOOKUP",
}
TOKEN = re.compile(
    r"""\s*("(?:[^"]|"")*"|(?:(?:'(?:[^']|'')+'|[^\W\d][\w .]*)!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+(?:\.\d*)?(?:E[+-]?\d+)?|[A-Z_][A-Z_0-9.]*|<>|<=|>=|[+\-*/&=<>(),])""",
    re.I,
)
PRECEDENCE = {
    "=": 1,
    "<>": 1,
    "<": 1,
    "<=": 1,
    ">": 1,
    ">=": 1,
    "&": 2,
    "+": 3,
    "-": 3,
    "*": 4,
    "/": 4,
}


def parse_formula(value: str) -> dict[str, object]:
    """只解析确定性Excel子集，名称引用、动态数组和外部书链接明确拒绝。"""
    source = value.removeprefix("=").strip()
    if len(source) > 2000:
        raise DomainError(422, "原始公式过长")
    tokens: list[str] = []
    offset = 0
    while offset < len(source):
        match = TOKEN.match(source, offset)
        if not match:
            raise DomainError(422, "原始公式含不支持的语法")
        tokens.append(match[1])
        offset = match.end()
    position = 0

    def expression(minimum: int = 0, depth: int = 0) -> dict[str, object]:
        nonlocal position
        if depth > 40 or position >= len(tokens):
            raise DomainError(422, "原始公式嵌套过深或缺少参数")
        token = tokens[position]
        position += 1
        node: dict[str, object]
        if token in {"+", "-"}:
            node = {
                "kind": "binary",
                "op": token,
                "left": {"kind": "literal", "value": 0},
                "right": expression(5, depth + 1),
            }
        elif token == "(":
            node = expression(0, depth + 1)
            if position >= len(tokens) or tokens[position] != ")":
                raise DomainError(422, "公式括号不匹配")
            position += 1
        elif token.startswith('"'):
            node = {"kind": "literal", "value": token[1:-1].replace('""', '"')}
        elif re.fullmatch(r"\d+(?:\.\d*)?(?:E[+-]?\d+)?", token, re.I):
            node = {"kind": "literal", "value": number(decimal(token))}
        elif token.upper() in {"TRUE", "FALSE"}:
            node = {"kind": "literal", "value": token.upper() == "TRUE"}
        elif position < len(tokens) and tokens[position] == "(":
            name = token.upper().removeprefix("_XLFN.")
            if name not in FUNCTIONS:
                raise DomainError(422, "原始公式函数不受支持：" + name)
            position += 1
            args: list[dict[str, object]] = []
            if position < len(tokens) and tokens[position] != ")":
                while True:
                    args.append(expression(0, depth + 1))
                    if len(args) > 100:
                        raise DomainError(422, "公式参数过多")
                    if position >= len(tokens) or tokens[position] != ",":
                        break
                    position += 1
            if position >= len(tokens) or tokens[position] != ")":
                raise DomainError(422, "公式函数括号不匹配")
            position += 1
            node = {"kind": "call", "name": name, "args": args}
        elif re.fullmatch(
            r"(?:(?:'(?:[^']|'')+'|[^\W\d][\w .]*)!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?",
            token,
            re.I,
        ):
            node = {"kind": "ref", "value": token}
        else:
            raise DomainError(422, "公式名称或引用不受支持")
        while (
            position < len(tokens)
            and tokens[position] in PRECEDENCE
            and PRECEDENCE[tokens[position]] >= minimum
        ):
            operator = tokens[position]
            position += 1
            node = {
                "kind": "binary",
                "op": operator,
                "left": node,
                "right": expression(PRECEDENCE[operator] + 1, depth + 1),
            }
        return node

    result = expression()
    if position != len(tokens):
        raise DomainError(422, "公式包含多余内容")
    return result


def scalar(value: Value) -> Cell:
    """需要单值的函数不静默选取范围首格。"""
    if isinstance(value, list):
        if len(value) != 1:
            raise DomainError(422, "公式此处需要单个值")
        return value[0]
    return value


def _numeric(value: Cell) -> Decimal:
    if value is None or value == "":
        return Decimal(0)
    if isinstance(value, bool):
        return Decimal(int(value))
    return decimal(value)


def _criteria(value: Cell, criterion: Cell) -> bool:
    if isinstance(criterion, str):
        match = re.fullmatch(r"(<=|>=|<>|=|<|>)?(.*)", criterion)
        assert match is not None
        operator, target = match[1] or "=", match[2]
        if operator in {"=", "<>"} and any(char in target for char in "*?~"):
            pattern, offset = "", 0
            while offset < len(target):
                char = target[offset]
                if char == "~" and offset + 1 < len(target):
                    offset += 1
                    pattern += re.escape(target[offset])
                else:
                    pattern += ".*" if char == "*" else "." if char == "?" else re.escape(char)
                offset += 1
            result = (
                re.fullmatch(pattern, str(value if value is not None else ""), re.I) is not None
            )
            return result if operator == "=" else not result
        try:
            right: Cell = number(decimal(target))
        except DomainError:
            right = target
    else:
        operator, right = "=", criterion
    left = value
    if left is None and right == "":
        left = ""
    if isinstance(left, str) and isinstance(right, str):
        left, right = left.casefold(), right.casefold()
    if operator == "=":
        return left == right
    if operator == "<>":
        return left != right
    try:
        a, b = _numeric(left), _numeric(right)
    except DomainError:
        return False
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[operator]


class FormulaWorkbook:
    """每本工作簿共享引用预算与缓存，跨工作表循环仍能被检测。"""

    def __init__(self, workbook: Workbook) -> None:
        self.workbook = workbook
        self.cache: dict[tuple[str, str], Cell] = {}
        self.visiting: set[tuple[str, str]] = set()
        self.budget = 500000

    def cell(self, sheet: str, address: str) -> Cell:
        """缓存只存本次实际重算结果，不读取文件声明的历史缓存。"""
        key = (sheet, address.replace("$", "").upper())
        if key in self.cache:
            return self.cache[key]
        if key in self.visiting or len(self.visiting) > 128:
            raise DomainError(422, "工作簿公式循环或依赖层级过深")
        if sheet not in self.workbook.sheetnames:
            raise DomainError(422, "公式引用工作表不存在")
        self.budget -= 1
        if self.budget < 0:
            raise DomainError(413, "工作簿公式计算量超过限制")
        self.visiting.add(key)
        try:
            cell = self.workbook[sheet][key[1]]
            raw = cell.value
            if cell.data_type == "f":
                if not isinstance(raw, str):
                    raise DomainError(422, "数组或共享公式不受支持")
                result = scalar(self.evaluate(parse_formula(raw), sheet))
            elif cell.data_type == "e":
                raise DomainError(422, "工作簿含错误单元格")
            elif isinstance(raw, (datetime, date)):
                result = raw.isoformat()[:10]
            elif raw is None or isinstance(raw, (str, int, float, bool)):
                result = raw
            else:
                raise DomainError(422, "工作簿单元格类型不受支持")
            self.cache[key] = result
            return result
        finally:
            self.visiting.remove(key)

    def evaluate(self, node: dict[str, object], sheet: str) -> Value:
        """固定函数语义按需求值IF分支，不执行函数名称以外的任何代码。"""
        if node["kind"] == "literal":
            value = node["value"]
            assert value is None or isinstance(value, (str, int, float, bool))
            return value
        if node["kind"] == "ref":
            value = str(node["value"])
            if "!" in value:
                sheet, value = value.rsplit("!", 1)
                sheet = sheet[1:-1].replace("''", "'") if sheet.startswith("'") else sheet
            left_column, top, right_column, bottom = range_boundaries(value)
            if (
                left_column is None
                or top is None
                or right_column is None
                or bottom is None
                or bottom > 5001
                or right_column > 64
                or top < 1
                or left_column < 1
                or (right_column - left_column + 1) * (bottom - top + 1) > 100000
            ):
                raise DomainError(422, "公式范围超过支持边界")
            from openpyxl.utils.cell import get_column_letter

            referenced_values = [
                self.cell(sheet, f"{get_column_letter(column)}{row}")
                for row in range(top, bottom + 1)
                for column in range(left_column, right_column + 1)
            ]
            return referenced_values if ":" in value else referenced_values[0]
        if node["kind"] == "binary":
            left = self.evaluate(record(node["left"], "公式"), sheet)
            right = self.evaluate(record(node["right"], "公式"), sheet)
            operator = str(node["op"])

            def calculate(a: Cell, b: Cell) -> Cell:
                if operator == "&":
                    return str(a if a is not None else "") + str(b if b is not None else "")
                if operator in {"=", "<>"} and isinstance(b, bool):
                    same = isinstance(a, bool) and a == b
                    return same if operator == "=" else not same
                if operator in {"=", "<>", "<", "<=", ">", ">="}:
                    return _criteria(a, operator + str(b if b is not None else ""))
                x, y = _numeric(a), _numeric(b)
                if operator == "+":
                    return number(x + y)
                if operator == "-":
                    return number(x - y)
                if operator == "*":
                    return number(x * y)
                if not y:
                    raise DomainError(422, "公式除以零")
                return number(x / y)

            if isinstance(left, list) or isinstance(right, list):
                length = (
                    len(left)
                    if isinstance(left, list)
                    else len(right)
                    if isinstance(right, list)
                    else 1
                )
                a = left if isinstance(left, list) else [left] * length
                b = right if isinstance(right, list) else [right] * length
                if len(a) != len(b):
                    raise DomainError(422, "公式范围大小不一致")
                return [calculate(x, y) for x, y in zip(a, b, strict=True)]
            return calculate(left, right)
        name, definitions = str(node["name"]), node["args"]
        assert isinstance(definitions, list)
        if name == "IF":
            if len(definitions) != 3:
                raise DomainError(422, "IF需要三个参数")
            decision = scalar(self.evaluate(record(definitions[0], "公式"), sheet))
            if isinstance(decision, str):
                raise DomainError(422, "IF需要明确的数值或逻辑条件")
            return self.evaluate(record(definitions[1 if decision else 2], "公式"), sheet)
        args = [self.evaluate(record(item, "公式"), sheet) for item in definitions]

        def values(index: int) -> list[Cell]:
            if index >= len(args):
                raise DomainError(422, "公式缺少参数")
            value = args[index]
            return value if isinstance(value, list) else [value]

        flat = [item for value in args for item in (value if isinstance(value, list) else [value])]
        if name == "XLOOKUP":
            if not 3 <= len(args) <= 5 or len(args) == 5 and scalar(args[4]) != 0:
                raise DomainError(422, "XLOOKUP只支持精确查找")
            keys, results = values(1), values(2)
            if len(keys) != len(results):
                raise DomainError(422, "查找范围大小不一致")
            target = scalar(args[0])
            index = next((index for index, key in enumerate(keys) if _criteria(key, target)), None)
            return results[index] if index is not None else scalar(args[3]) if len(args) > 3 else ""
        if name in {"SUMIF", "SUMIFS", "AVERAGEIF", "COUNTIF", "COUNTIFS", "MINIFS", "MAXIFS"}:
            single, counting = name in {"SUMIF", "AVERAGEIF", "COUNTIF"}, name.startswith("COUNT")
            data = values(0 if counting or not single or len(args) < 3 else 2)
            indices = [0] if single else list(range(0 if counting else 1, len(args), 2))
            if not indices or any(
                index + 1 >= len(args) or len(values(index)) != len(data) for index in indices
            ):
                raise DomainError(422, "条件汇总范围或参数不匹配")

            def filtered(array_index: int | None = None) -> Cell:
                keep = [
                    value
                    for offset, value in enumerate(data)
                    if all(
                        _criteria(
                            values(index)[offset],
                            values(index + 1)[array_index]
                            if array_index is not None and isinstance(args[index + 1], list)
                            else scalar(args[index + 1]),
                        )
                        for index in indices
                    )
                ]
                if counting:
                    return len(keep)
                numbers = [
                    decimal(value)
                    for value in keep
                    if isinstance(value, (int, float)) and not isinstance(value, bool)
                ]
                if name == "MINIFS":
                    return number(min(numbers, default=Decimal(0)))
                if name == "MAXIFS":
                    return number(max(numbers, default=Decimal(0)))
                if name == "AVERAGEIF" and not numbers:
                    raise DomainError(422, "平均值没有可计算数值")
                return number(
                    sum(numbers, Decimal(0)) / len(numbers)
                    if name == "AVERAGEIF"
                    else sum(numbers, Decimal(0))
                )

            arrays = [values(index + 1) for index in indices if isinstance(args[index + 1], list)]
            if arrays:
                if any(len(array) != len(arrays[0]) for array in arrays):
                    raise DomainError(422, "条件数组长度不一致")
                return [filtered(index) for index in range(len(arrays[0]))]
            return filtered()
        if name in {"DATE", "DATEVALUE", "YEAR", "MONTH", "DAY", "TEXT"}:
            try:
                if name == "DATE":
                    if len(args) != 3:
                        raise DomainError(422, "DATE需要三个参数")
                    result = date(*(int(_numeric(scalar(value))) for value in args))
                    return (result - date(1899, 12, 30)).days
                if name == "DATEVALUE":
                    return (valid_date(scalar(args[0])) - date(1899, 12, 30)).days
                raw_date = scalar(args[0])
                parsed = (
                    valid_date(raw_date)
                    if isinstance(raw_date, str)
                    else date(1899, 12, 30) + timedelta(days=float(_numeric(raw_date)))
                )
                if name == "TEXT":
                    if len(args) != 2 or scalar(args[1]) != "yyyy-mm-dd":
                        raise DomainError(422, "TEXT只支持yyyy-mm-dd")
                    return parsed.isoformat()
                return {"YEAR": parsed.year, "MONTH": parsed.month, "DAY": parsed.day}[name]
            except (ValueError, OverflowError, IndexError) as error:
                raise DomainError(422, "日期公式无效") from error
        if name == "SUBSTITUTE":
            if (
                len(args) != 3
                or not isinstance(scalar(args[1]), str)
                or not isinstance(scalar(args[2]), str)
            ):
                raise DomainError(422, "SUBSTITUTE需要文本及替换参数")
            old, new = str(scalar(args[1])), str(scalar(args[2]))

            def substitute(value: Cell) -> str:
                return (
                    str(value if value is not None else "").replace(old, new)
                    if old
                    else str(value or "")
                )

            return (
                [substitute(value) for value in values(0)]
                if isinstance(args[0], list)
                else substitute(scalar(args[0]))
            )
        if name in {"TRIM", "UPPER", "LOWER"}:
            if len(args) != 1:
                raise DomainError(422, "文本公式参数不匹配")
            value = str(scalar(args[0]) or "")
            return (
                " ".join(value.split())
                if name == "TRIM"
                else value.upper()
                if name == "UPPER"
                else value.lower()
            )
        if name == "SUMPRODUCT" and len(args) > 1:
            ranges = [values(index) for index in range(len(args))]
            if any(len(items) != len(ranges[0]) for items in ranges):
                raise DomainError(422, "SUMPRODUCT范围大小不一致")
            total = Decimal(0)
            for offset in range(len(ranges[0])):
                product = Decimal(1)
                for items in ranges:
                    product *= _numeric(items[offset])
                total += product
            return number(total)
        if name in {"AND", "OR", "NOT"}:
            if any(not isinstance(value, (bool, int, float)) for value in flat) or not flat:
                raise DomainError(422, "逻辑公式需要明确比较结果")
            return all(flat) if name == "AND" else any(flat) if name == "OR" else not flat[0]
        if name in {"CONCAT", "CONCATENATE"}:
            return "".join(str(value) if value is not None else "" for value in flat)
        if name == "ROUND":
            if (
                len(flat) != 2
                or not -12 <= _numeric(flat[1]) <= 12
                or int(_numeric(flat[1])) != _numeric(flat[1])
            ):
                raise DomainError(422, "ROUND参数无效")
            return number(
                _numeric(flat[0]).quantize(
                    Decimal(1).scaleb(-int(_numeric(flat[1]))), rounding=ROUND_HALF_UP
                )
            )
        if name == "ABS":
            if len(flat) != 1:
                raise DomainError(422, "ABS参数无效")
            return number(abs(_numeric(flat[0])))
        if name == "COUNTA":
            return sum(value is not None for value in flat)
        numeric = [
            decimal(value)
            for value in flat
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ]
        if name == "COUNT":
            return len(numeric)
        if name == "MIN":
            return number(min(numeric, default=Decimal(0)))
        if name == "MAX":
            return number(max(numeric, default=Decimal(0)))
        if name == "AVERAGE" and not numeric:
            raise DomainError(422, "平均值没有有效数值")
        if name not in {"SUM", "SUMPRODUCT", "AVERAGE"}:
            raise DomainError(422, "原始公式函数未实现")
        return number(
            sum(numeric, Decimal(0)) / len(numeric)
            if name == "AVERAGE"
            else sum(numeric, Decimal(0))
        )

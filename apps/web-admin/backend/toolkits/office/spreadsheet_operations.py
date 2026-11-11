"""表格转换、连接、分组与透视，所有步骤均有行列及展开限额。"""

import copy
import json
import re
from functools import cmp_to_key

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Cell, record, sequence, text
from toolkits.office.spreadsheet_values import (
    Table,
    aggregate,
    condition,
    decimal,
    evaluate,
    number,
    valid_date,
)


def _names(value: object) -> list[str]:
    return [text(item, "字段", 100) for item in sequence(value, "字段", 64)]


def _valid(table: Table) -> None:
    if (
        not table.columns
        or len(table.columns) > 64
        or len(set(table.columns)) != len(table.columns)
        or len(table.rows) > 5000
    ):
        raise DomainError(422, "操作结果为空列、列名重复或行列数超过限制")


def _currency(table: Table, groups: list[str], explicit: object) -> None:
    name = (
        str(explicit)
        if explicit
        else next(
            (
                item
                for item in table.columns
                if re.fullmatch(r"currency|currencycode|币种|货币|货币代码", item, re.I)
            ),
            None,
        )
    )
    if name and name not in groups:
        index = table.column(name)
        if (
            len(
                {
                    str(row[index])
                    for row in table.rows
                    if row[index] is not None and row[index] != ""
                }
            )
            > 1
        ):
            raise DomainError(422, "存在多个币种，请将币种加入分组，不能直接合计")


def operations(
    source: Table, definitions: object, available: dict[str, Table], issues: list[dict[str, object]]
) -> Table:
    """只解释固定操作集合，用户数据和指令不会变成可执行脚本。"""
    table = copy.deepcopy(source)
    for raw in sequence(definitions, "表格操作", 100):
        operation = record(raw, "表格操作")
        kind = operation.get("type")
        if kind == "select":
            columns = _names(operation.get("columns"))
            indices = [table.column(name) for name in columns]
            table.rows = [[row[index] for index in indices] for row in table.rows]
            table.columns = columns
            table.formulas = {
                name: value for name, value in table.formulas.items() if name in columns
            }
        elif kind == "rename":
            mapping = record(operation.get("columns"), "重命名")
            if table.formulas:
                raise DomainError(422, "请在添加公式之前重命名字段")
            for name in mapping:
                table.column(name)
            table.columns = [text(mapping.get(name, name), "字段", 100) for name in table.columns]
        elif kind == "trim":
            indices = [table.column(name) for name in _names(operation.get("columns"))]
            table.rows = [
                [
                    value.strip() if index in indices and isinstance(value, str) else value
                    for index, value in enumerate(row)
                ]
                for row in table.rows
            ]
        elif kind == "convert":
            index = table.column(operation.get("column"))
            target = operation.get("to")
            if target not in {"number", "text", "date", "boolean"} or operation.get(
                "onInvalid", "error"
            ) not in {"error", "blank"}:
                raise DomainError(422, "字段转换类型无效")
            for offset, row in enumerate(table.rows):
                value = row[index]
                if value is None or value == "":
                    continue
                try:
                    if target == "number":
                        row[index] = number(decimal(value))
                    elif target == "text":
                        row[index] = str(value)
                    elif target == "date":
                        row[index] = valid_date(value).isoformat()
                    elif str(value).lower() in {"true", "1", "是", "false", "0", "否"}:
                        row[index] = str(value).lower() in {"true", "1", "是"}
                    else:
                        raise DomainError(422, "无法转换为布尔值")
                except DomainError:
                    if operation.get("onInvalid") != "blank":
                        raise
                    row[index] = None
                    issues.append(
                        {
                            "severity": "warning",
                            "code": "conversion_blank",
                            "message": "无法转换的值已按方案置空",
                            "tableId": table.id,
                            "row": table.row_numbers[offset],
                            "column": table.columns[index],
                        }
                    )
        elif kind == "filter":
            predicates = sequence(operation.get("conditions"), "筛选条件", 30, 1)
            if operation.get("match", "all") not in {"all", "any"}:
                raise DomainError(422, "筛选匹配方式无效")
            compare = any if operation.get("match") == "any" else all
            kept = [
                index
                for index, row in enumerate(table.rows)
                if compare(condition(predicate, table, row) for predicate in predicates)
            ]
            table.rows, table.row_numbers = (
                [table.rows[index] for index in kept],
                [table.row_numbers[index] for index in kept],
            )
        elif kind == "sort":
            sort_keys = [
                record(value, "排序", {"column", "direction"})
                for value in sequence(operation.get("by"), "排序", 10, 1)
            ]
            for key in sort_keys:
                table.column(key.get("column"))
                if key.get("direction", "asc") not in {"asc", "desc"}:
                    raise DomainError(422, "排序方向无效")

            def compare_rows(
                left: int,
                right: int,
                table: Table = table,
                keys: list[dict[str, object]] = sort_keys,
            ) -> int:
                for key in keys:
                    index = table.column(key["column"])
                    a, b = table.rows[left][index], table.rows[right][index]
                    if a == b:
                        continue
                    if a is None:
                        result = -1
                    elif b is None:
                        result = 1
                    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
                        result = -1 if a < b else 1
                    else:
                        result = -1 if str(a) < str(b) else 1
                    return -result if key.get("direction") == "desc" else result
                return left - right

            indices = sorted(range(len(table.rows)), key=cmp_to_key(compare_rows))
            table.rows, table.row_numbers = (
                [table.rows[index] for index in indices],
                [table.row_numbers[index] for index in indices],
            )
        elif kind == "dedup":
            indices = [table.column(name) for name in _names(operation.get("columns"))]
            if not indices:
                raise DomainError(422, "去重必须选择字段")
            seen: set[str] = set()
            keep = []
            for index, row in enumerate(table.rows):
                row_key = json.dumps([row[column] for column in indices], ensure_ascii=False)
                if row_key not in seen:
                    seen.add(row_key)
                    keep.append(index)
            table.rows, table.row_numbers = (
                [table.rows[index] for index in keep],
                [table.row_numbers[index] for index in keep],
            )
        elif kind == "concat":
            for identifier in _names(operation.get("tables")):
                other = available.get(identifier)
                if other is None or other.columns != table.columns:
                    raise DomainError(422, "追加表不存在或字段顺序不同")
                table.rows.extend(copy.deepcopy(other.rows))
                table.row_numbers.extend(other.row_numbers)
                _valid(table)
        elif kind == "join":
            other = available.get(str(operation.get("table")))
            if other is None or operation.get("how", "left") not in {"left", "inner"}:
                raise DomainError(422, "关联表不存在或关联方式无效")
            left, right = (
                table.column(operation.get("leftKey")),
                other.column(operation.get("rightKey")),
            )
            mapping = record(operation.get("columns"), "关联字段")
            mapped = [
                (other.column(key), text(value, "目标字段", 100)) for key, value in mapping.items()
            ]
            lookup: dict[str, list[list[Cell]]] = {}
            for row in other.rows:
                lookup.setdefault(json.dumps(row[right]), []).append(row)
            rows: list[list[Cell]] = []
            numbers: list[int] = []
            for offset, row in enumerate(table.rows):
                matches = lookup.get(json.dumps(row[left]), [])
                if not matches and operation.get("how", "left") == "left":
                    rows.append(row + [None] * len(mapped))
                    numbers.append(table.row_numbers[offset])
                for match in matches:
                    rows.append(row + [match[index] for index, _ in mapped])
                    numbers.append(table.row_numbers[offset])
                    if len(rows) > 5000:
                        raise DomainError(413, "关联展开超过5000行，请先去重或聚合")
            table.columns += [name for _, name in mapped]
            table.rows, table.row_numbers = rows, numbers
        elif kind == "group":
            groups = _names(operation.get("by"))
            _currency(table, groups, operation.get("currencyColumn"))
            keys = [table.column(name) for name in groups]
            definitions = [
                record(item, "聚合", {"column", "as", "operation"})
                for item in sequence(operation.get("aggregates"), "聚合", 64, 1)
            ]
            indices = [table.column(item.get("column")) for item in definitions]
            buckets: dict[str, list[list[Cell]]] = {}
            for row in table.rows:
                buckets.setdefault(json.dumps([row[index] for index in keys]), []).append(row)
            table.rows = [
                [
                    *json.loads(key),
                    *(
                        aggregate(str(item["operation"]), [row[index] for row in rows])
                        for item, index in zip(definitions, indices, strict=True)
                    ),
                ]
                for key, rows in buckets.items()
            ]
            table.columns = groups + [text(item.get("as"), "聚合列名", 100) for item in definitions]
            table.row_numbers, table.formulas = list(range(2, len(table.rows) + 2)), {}
        elif kind == "pivot":
            groups = _names(operation.get("rows"))
            pivot = table.column(operation.get("columns"))
            value = table.column(operation.get("value"))
            keys = [table.column(name) for name in groups]
            _currency(table, groups + [table.columns[pivot]], operation.get("currencyColumn"))
            aggregate_name = str(operation.get("operation"))
            if aggregate_name not in {"sum", "count"}:
                raise DomainError(422, "透视只支持求和或计数")
            labels = list(
                dict.fromkeys(
                    str(row[pivot] if row[pivot] is not None else "空值") for row in table.rows
                )
            )
            if len(labels) + len(groups) > 64:
                raise DomainError(422, "透视结果列过多")
            buckets = {}
            for row in table.rows:
                buckets.setdefault(json.dumps([row[index] for index in keys]), []).append(row)
            table.rows = [
                [
                    *json.loads(key),
                    *(
                        aggregate(
                            aggregate_name,
                            [
                                row[value]
                                for row in rows
                                if str(row[pivot] if row[pivot] is not None else "空值") == label
                            ],
                        )
                        for label in labels
                    ),
                ]
                for key, rows in buckets.items()
            ]
            table.columns = groups + labels
            table.row_numbers, table.formulas = list(range(2, len(table.rows) + 2)), {}
        elif kind == "formula":
            column = text(operation.get("column"), "公式列", 100)
            if column in table.columns:
                raise DomainError(422, "公式列不能覆盖已有字段")
            expression = operation.get("expression")
            computed = [evaluate(expression, table, row, available) for row in table.rows]
            table.columns.append(column)
            for row, value in zip(table.rows, computed, strict=True):
                row.append(value)
            table.formulas[column] = {
                "expression": expression,
                "numberFormat": text(operation["numberFormat"], "数字格式", 100)
                if operation.get("numberFormat")
                else None,
            }
        else:
            raise DomainError(422, "表格操作不受支持")
        _valid(table)
    return table

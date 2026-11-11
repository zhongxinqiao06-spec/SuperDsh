"""按稳定章节或页面ID修订，未指定节点保持原结构及顺序。"""

import copy

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import record, sequence, text


def revise_structure(
    previous: dict[str, object], changes: object, expected_hash: str
) -> dict[str, object]:
    """必须匹配保存成果的结构摘要，旧确认不能覆盖新成果。"""
    patch = record(changes, "修订", {"baseHash", "changes", "designTheme", "brand", "title"})
    if patch.get("baseHash") != expected_hash:
        raise DomainError(409, "成果方案版本已变化，请重新读取后修改")
    field = (
        "slides"
        if isinstance(previous.get("slides"), list)
        else "sections"
        if isinstance(previous.get("sections"), list)
        else None
    )
    if field is None:
        raise DomainError(422, "此成果不支持按页面或章节修订")
    result = copy.deepcopy(previous)
    nodes = sequence(result[field], "页面或章节", 60, 1)
    for item in sequence(patch.get("changes"), "变更", 100):
        change = record(item, "变更", {"op", "id", "value"})
        identifier = text(change.get("id"), "页面或章节ID", 100)
        index = next(
            (
                offset
                for offset, node in enumerate(nodes)
                if isinstance(node, dict) and node.get("id") == identifier
            ),
            None,
        )
        if index is None:
            raise DomainError(422, "修订目标不存在")
        if change.get("op") == "remove":
            nodes.pop(index)
        elif change.get("op") in {"replace", "insertAfter"}:
            value = record(change.get("value"), "变更内容")
            new_id = text(value.get("id"), "新增ID", 100)
            if change["op"] == "replace":
                if new_id != identifier:
                    raise DomainError(422, "替换内容须保留原ID")
                nodes[index] = copy.deepcopy(value)
            else:
                if any(isinstance(node, dict) and node.get("id") == new_id for node in nodes):
                    raise DomainError(422, "新增ID不能重复")
                nodes.insert(index + 1, copy.deepcopy(value))
        else:
            raise DomainError(422, "只支持替换、删除和后插入修订")
    if not nodes:
        raise DomainError(422, "成果至少保留一个页面或章节")
    result[field] = nodes
    if "designTheme" in patch and field == "slides":
        result["designTheme"] = record(patch["designTheme"], "主题")
    if "brand" in patch:
        result["brand"] = {
            **record(result.get("brand", {}), "品牌"),
            **record(patch["brand"], "品牌"),
        }
    if "title" in patch:
        result["title"] = text(patch["title"], "标题", 200)
    return result

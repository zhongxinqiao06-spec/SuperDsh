"""配置的保守公开投影；任一 Schema 分支敏感即隐藏，不将秘密写入读取快照。"""

import copy
import re
from urllib.parse import unquote

from app.infrastructure.errors import DomainError


def merge_settings(
    previous: dict[str, object], update: dict[str, object], depth: int = 0
) -> dict[str, object]:
    """对象递归合并保留未提交的嵌套秘密；数组和显式 null 按新值整体替换。"""
    if depth > 64:
        raise DomainError(422, "configuration nesting is too deep")
    result = copy.deepcopy(previous)
    for key, value in update.items():
        old = previous.get(key)
        result[key] = (
            merge_settings(old, value, depth + 1)
            if isinstance(old, dict) and isinstance(value, dict)
            else copy.deepcopy(value)
        )
    return result


class ConfigurationProjection:
    """本地引用与组合展开按节点去重；数据递归、节点数分别有限额。"""

    def __init__(self, root: dict[str, object]) -> None:
        self.root = root
        self.anchors: dict[str, list[dict[str, object]]] = {}
        pending: list[object] = [root]
        count = 0
        while pending:
            value = pending.pop()
            count += 1
            if count > 10000:
                raise DomainError(422, "configuration schema is too complex")
            if isinstance(value, dict):
                if (
                    (value is not root and "$id" in value)
                    or "$recursiveRef" in value
                    or "contentSchema" in value
                ):
                    raise DomainError(
                        422,
                        "configuration schema uses an unsupported scoped reference or encoded content schema",
                    )
                for key in ("$anchor", "$dynamicAnchor"):
                    if isinstance(value.get(key), str):
                        self.anchors.setdefault(str(value[key]), []).append(value)
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)

    def _reference(self, reference: str) -> list[dict[str, object]]:
        if not reference.startswith("#"):
            raise DomainError(422, "configuration schema requires local references")
        pointer = unquote(reference[1:])
        if pointer and not pointer.startswith("/"):
            matches = self.anchors.get(pointer, [])
            if not matches:
                raise DomainError(422, "configuration schema reference is unresolved")
            return matches
        target: object = self.root
        try:
            for part in pointer.split("/")[1:]:
                key = part.replace("~1", "/").replace("~0", "~")
                if isinstance(target, dict):
                    target = target[key]
                elif isinstance(target, list):
                    target = target[int(key)]
                else:
                    raise KeyError(key)
        except (KeyError, IndexError, ValueError) as error:
            raise DomainError(422, "configuration schema reference is unresolved") from error
        if isinstance(target, bool):
            return []
        if not isinstance(target, dict):
            raise DomainError(422, "configuration schema reference is invalid")
        return [target]

    def _variants(self, schemas: list[dict[str, object]]) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        seen: set[int] = set()
        pending = list(schemas)
        while pending:
            current = pending.pop()
            if id(current) in seen:
                continue
            seen.add(id(current))
            if len(seen) > 1000:
                raise DomainError(422, "configuration schema expansion is too complex")
            result.append(current)
            for key in ("$ref", "$dynamicRef"):
                reference = current.get(key)
                if isinstance(reference, str):
                    pending.extend(self._reference(reference))
            for key in ("allOf", "anyOf", "oneOf"):
                branches = current.get(key, [])
                if isinstance(branches, list):
                    pending.extend(branch for branch in branches if isinstance(branch, dict))
            for key in ("if", "then", "else", "not"):
                branch = current.get(key)
                if isinstance(branch, dict):
                    pending.append(branch)
            for key in ("dependentSchemas", "dependencies"):
                branches = current.get(key, {})
                if isinstance(branches, dict):
                    pending.extend(
                        branch for branch in branches.values() if isinstance(branch, dict)
                    )
        return result

    def _properties(self, variants: list[dict[str, object]], key: str) -> list[dict[str, object]]:
        candidates: list[dict[str, object]] = []
        for variant in variants:
            matched = False
            properties = variant.get("properties", {})
            if isinstance(properties, dict) and key in properties:
                matched = True
                if isinstance(properties[key], dict):
                    candidates.append(properties[key])
            patterns = variant.get("patternProperties", {})
            if isinstance(patterns, dict):
                for pattern, schema in patterns.items():
                    try:
                        if re.search(str(pattern), key):
                            matched = True
                            if isinstance(schema, dict):
                                candidates.append(schema)
                    except re.error as error:
                        raise DomainError(422, "configuration schema pattern is invalid") from error
            additional = variant.get("additionalProperties")
            if not matched and isinstance(additional, dict):
                candidates.append(additional)
            unevaluated = variant.get("unevaluatedProperties")
            if isinstance(unevaluated, dict):
                candidates.append(unevaluated)
        return candidates

    def _items(self, variants: list[dict[str, object]], index: int) -> list[dict[str, object]]:
        candidates: list[dict[str, object]] = []
        for variant in variants:
            prefix = variant.get("prefixItems", [])
            definition = (
                prefix[index]
                if isinstance(prefix, list) and index < len(prefix)
                else variant.get("items")
            )
            if isinstance(definition, list):
                definition = (
                    definition[index] if index < len(definition) else variant.get("additionalItems")
                )
            if isinstance(definition, dict):
                candidates.append(definition)
            for key in ("contains", "unevaluatedItems"):
                definition = variant.get(key)
                if isinstance(definition, dict):
                    candidates.append(definition)
        return candidates

    def project(
        self, value: object, schemas: list[dict[str, object]], path: str = "", depth: int = 0
    ) -> tuple[object, list[str], bool]:
        """返回公开值、设置路径和整个节点敏感性，不泄露秘密长度或内容。"""
        if depth > 64:
            raise DomainError(422, "configuration nesting is too deep")
        variants = self._variants(schemas)
        if any(variant.get("writeOnly") is True for variant in variants):
            return None, [path or "$"] if value is not None else [], True
        if isinstance(value, dict):
            output: dict[str, object] = {}
            configured: list[str] = []
            for key, item in value.items():
                projected, secrets, sensitive = self.project(
                    item,
                    self._properties(variants, str(key)),
                    f"{path}.{key}".lstrip("."),
                    depth + 1,
                )
                if not sensitive:
                    output[str(key)] = projected
                configured.extend(secrets)
            return output, configured, False
        if isinstance(value, list):
            output_items: list[object] = []
            configured = []
            for index, item in enumerate(value):
                projected, secrets, _ = self.project(
                    item, self._items(variants, index), f"{path}[{index}]", depth + 1
                )
                output_items.append(projected)
                configured.extend(secrets)
            return output_items, configured, False
        return value, [], False


def redact_settings(value: object, schema: dict[str, object]) -> tuple[object, list[str]]:
    """公开配置唯一入口；根敏感时返回空配置和设置状态。"""
    projected, configured, sensitive = ConfigurationProjection(schema).project(value, [schema])
    return ({} if sensitive else projected), configured

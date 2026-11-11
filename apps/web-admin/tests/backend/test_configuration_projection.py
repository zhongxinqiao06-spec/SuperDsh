"""配置秘密通过引用、联合、数组与额外属性声明时，公开快照仍必须保守隐藏。"""

import pytest

from app.infrastructure.errors import DomainError
from app.modules.resources.service.configuration import merge_settings, redact_settings


def test_nested_references_combinations_patterns_and_arrays_hide_secrets() -> None:
    schema: dict[str, object] = {
        "$defs": {
            "secret": {"type": "string", "writeOnly": True},
            "recursive": {
                "type": "object",
                "properties": {
                    "token": {"$ref": "#/$defs/secret"},
                    "next": {"$ref": "#/$defs/recursive"},
                },
            },
        },
        "type": "object",
        "properties": {
            "reference": {"$ref": "#/$defs/secret"},
            "union": {"anyOf": [{"type": "string"}, {"$ref": "#/$defs/secret"}]},
            "all": {"allOf": [{"type": "object"}, {"properties": {"token": {"writeOnly": True}}}]},
            "one": {"oneOf": [{"type": "string"}, {"type": "null", "writeOnly": True}]},
            "array": {
                "type": "array",
                "items": {
                    "properties": {"token": {"$ref": "#/$defs/secret"}, "label": {"type": "string"}}
                },
            },
            "tuple": {
                "type": "array",
                "prefixItems": [{"writeOnly": True}],
                "items": {"type": "string"},
            },
            "recursive": {"$ref": "#/$defs/recursive"},
            "public": {"type": "string"},
        },
        "patternProperties": {"^secret_": {"$ref": "#/$defs/secret"}},
        "additionalProperties": {"writeOnly": True},
    }
    value = {
        "reference": "first-secret",
        "union": "second-secret",
        "all": {"token": "third-secret", "label": "shown"},
        "one": "fourth-secret",
        "array": [{"token": "fifth-secret", "label": "shown"}],
        "tuple": ["sixth-secret", "shown"],
        "recursive": {"token": "seventh-secret", "next": {"token": "eighth-secret"}},
        "public": "shown",
        "secret_dynamic": "ninth-secret",
        "unknown": "tenth-secret",
    }
    result, configured = redact_settings(value, schema)
    assert result == {
        "all": {"label": "shown"},
        "array": [{"label": "shown"}],
        "tuple": [None, "shown"],
        "recursive": {"next": {}},
        "public": "shown",
    }
    assert set(configured) == {
        "reference",
        "union",
        "all.token",
        "one",
        "array[0].token",
        "tuple[0]",
        "recursive.token",
        "recursive.next.token",
        "secret_dynamic",
        "unknown",
    }
    assert "secret" not in str(result)


def test_anchors_cycles_depth_limits_and_nested_merge() -> None:
    assert redact_settings(
        {"token": "secret"},
        {
            "$defs": {"value": {"$anchor": "private", "writeOnly": True}},
            "properties": {"token": {"$ref": "#private"}},
        },
    ) == ({}, ["token"])
    assert redact_settings(
        {"token": "secret"}, {"$ref": "#", "properties": {"token": {"writeOnly": True}}}
    ) == ({}, ["token"])
    nested: dict[str, object] = {}
    for _ in range(70):
        nested = {"next": nested}
    with pytest.raises(DomainError, match="nesting"):
        redact_settings(nested, {"type": "object"})
    with pytest.raises(DomainError, match="unsupported"):
        redact_settings({}, {"$defs": {"nested": {"$id": "nested"}}})
    assert merge_settings(
        {"nested": {"secret": "keep", "label": "old"}, "array": ["old"]},
        {"nested": {"label": "new"}, "array": ["new"]},
    ) == {"nested": {"secret": "keep", "label": "new"}, "array": ["new"]}

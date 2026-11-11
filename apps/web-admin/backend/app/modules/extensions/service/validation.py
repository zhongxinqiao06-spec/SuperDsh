"""包路径及不可信Schema验证，限制归档越界与高开销正则。"""

import base64
import binascii
import hashlib
import json
import re
from pathlib import PurePosixPath

from app.infrastructure.errors import DomainError
from app.infrastructure.schema_validation import JsonSchemaValidator
from app.modules.identity.entity.bo.models import PERMISSIONS


def digest(value: object) -> str:
    """确定性内容摘要用于MCP重新授权，不包含运行凭据。"""
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def package_path(value: str) -> str:
    """跨平台拒绝绝对、保留、大小写歧义及父目录路径。"""
    parts = value.split("/")
    if (
        not value
        or len(value) > 240
        or "\\" in value
        or ":" in value
        or any(ord(char) < 32 for char in value)
        or PurePosixPath(value).is_absolute()
        or any(
            part in {"", ".", ".."}
            or part.endswith((".", " "))
            or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)
            for part in parts
        )
    ):
        raise DomainError(422, "归档包含无效路径")
    return value


def decode_archive(value: str, limit: int) -> bytes:
    """严格Base64和解码前后双重大小限制。"""
    if len(value) > (limit + 2) // 3 * 4:
        raise DomainError(413, "归档超过大小限制")
    try:
        result = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise DomainError(422, "归档编码无效") from error
    if not result or len(result) > limit or base64.b64encode(result).decode() != value:
        raise DomainError(422, "归档编码无效或超过大小限制")
    return result


def object_schema(value: object) -> dict[str, object]:
    """扩展Schema不允许外部引用、任意正则或过深嵌套。"""
    if (
        not isinstance(value, dict)
        or value.get("type") != "object"
        or len(json.dumps(value)) > 32000
    ):
        raise DomainError(422, "Schema必须是有界的object")

    def visit(node: object, depth: int = 0) -> None:
        if depth > 16:
            raise DomainError(422, "Schema嵌套过深")
        if isinstance(node, dict):
            for key, item in node.items():
                if key in {
                    "$ref",
                    "$dynamicRef",
                    "$recursiveRef",
                    "__proto__",
                    "constructor",
                    "prototype",
                    "pattern",
                    "patternProperties",
                }:
                    raise DomainError(422, "Schema包含不受支持的属性")
                visit(item, depth + 1)
        elif isinstance(node, list):
            for item in node:
                visit(item, depth + 1)

    visit(value)
    JsonSchemaValidator().check_schema(value)
    return value


def tool_descriptor(value: object) -> dict[str, object]:
    """验证声明权限、时限和Schema，不接受未注册的权限标识。"""
    if not isinstance(value, dict) or not re.fullmatch(
        r"[a-zA-Z][a-zA-Z0-9_.-]{0,99}", str(value.get("id", ""))
    ):
        raise DomainError(422, "无效工具声明")
    for key, limit in (("name", 100), ("description", 4000)):
        if not isinstance(value.get(key), str) or not 1 <= len(str(value[key]).strip()) <= limit:
            raise DomainError(422, "工具名称或说明无效")
    if value.get("mode") not in {"read", "action", "office"}:
        raise DomainError(422, "工具执行方式无效")
    if "supportsPreparation" in value and not isinstance(value["supportsPreparation"], bool):
        raise DomainError(422, "工具准备能力必须为布尔值")
    read_actions = value.get("readActions", [])
    if (
        not isinstance(read_actions, list)
        or len(read_actions) > 20
        or any(
            not isinstance(action, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,39}", action)
            for action in read_actions
        )
    ):
        raise DomainError(422, "工具只读动作声明无效")
    grants = value.get("permissions")
    if not isinstance(grants, list) or any(
        not isinstance(item, str) or item not in PERMISSIONS for item in grants
    ):
        raise DomainError(422, "工具权限无效")
    timeout = value.get("timeoutSeconds", 120)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 600:
        raise DomainError(422, "工具超时必须为1至600秒")
    result = {
        **value,
        "timeoutSeconds": timeout,
        "inputSchema": object_schema(value.get("inputSchema")),
        "configurationSchema": object_schema(
            value.get(
                "configurationSchema",
                {"type": "object", "properties": {}, "additionalProperties": False},
            )
        ),
    }
    if value.get("outputSchema") is not None:
        result["outputSchema"] = object_schema(value["outputSchema"])
    artifact_types = value.get("artifactTypes", [])
    if (
        not isinstance(artifact_types, list)
        or len(artifact_types) > 30
        or any(not isinstance(item, str) or not 1 <= len(item) <= 150 for item in artifact_types)
    ):
        raise DomainError(422, "工具成果类型无效")
    configuration = result["configurationSchema"]
    assert isinstance(configuration, dict)
    properties = configuration.get("properties", {})

    def nested_secrets(node: object, depth: int) -> None:
        if isinstance(node, dict):
            if node.get("writeOnly") is True and depth != 1:
                raise DomainError(422, "凭据只能声明在配置顶层属性")
            for key, child in node.items():
                nested_secrets(child, depth + (1 if key in {"properties", "items"} else 0))
        elif isinstance(node, list):
            for child in node:
                nested_secrets(child, depth)

    nested_secrets(configuration, 0)
    presets = value.get("configurationPresets", [])
    if not isinstance(presets, list) or len(presets) > 30:
        raise DomainError(422, "配置预设过多")
    for preset in presets:
        if not isinstance(preset, dict) or not isinstance(preset.get("values"), dict):
            raise DomainError(422, "配置预设无效")
        for key in preset["values"]:
            definition = properties.get(key) if isinstance(properties, dict) else None
            if isinstance(definition, dict) and definition.get("writeOnly"):
                raise DomainError(422, "配置预设不能包含凭据")
        JsonSchemaValidator().validate(
            preset["values"],
            {key: item for key, item in configuration.items() if key != "required"},
        )
    return result


def manifest_definition(value: object) -> dict[str, object]:
    """清单是唯一执行入口，版本来自包元数据，安装后不可变。"""
    if (
        not isinstance(value, dict)
        or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,99}", str(value.get("id", "")))
        or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?", str(value.get("version", "")))
    ):
        raise DomainError(422, "扩展ID或语义版本无效")
    if value.get("runtime") not in {"node", "python", "mcp-stdio"}:
        raise DomainError(422, "扩展运行时不受支持")
    for key, maximum in (("name", 100), ("description", 4000), ("license", 100)):
        if not isinstance(value.get(key), str) or not 1 <= len(str(value[key]).strip()) <= maximum:
            raise DomainError(422, "扩展名称、说明及许可证必须填写")
    package_path(str(value.get("entrypoint", "")))
    raw_tools = value.get("tools")
    if not isinstance(raw_tools, list) or not 1 <= len(raw_tools) <= 100:
        raise DomainError(422, "扩展必须声明1至100个工具")
    tools = [tool_descriptor(tool) for tool in raw_tools]
    if len({tool["id"] for tool in tools}) != len(tools):
        raise DomainError(422, "扩展工具ID重复")
    skills = value.get("skills", [])
    if not isinstance(skills, list) or len(skills) > 100:
        raise DomainError(422, "扩展技能清单无效")
    seen: set[str] = set()
    for skill in skills:
        if (
            not isinstance(skill, dict)
            or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,99}", str(skill.get("id", "")))
            or skill["id"] in seen
        ):
            raise DomainError(422, "扩展技能ID无效或重复")
        seen.add(str(skill["id"]))
        path = package_path(str(skill.get("entrypoint", "")))
        if not path.endswith("/SKILL.md") and path != "SKILL.md":
            raise DomainError(422, "技能入口必须是SKILL.md")
    return {**value, "tools": tools}

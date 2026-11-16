"""本地 JSON Schema 验证，不解析任意远端引用或下载内容。"""

import json

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from referencing.exceptions import Unresolvable

from app.infrastructure.errors import DomainError


class JsonSchemaValidator:
    """工具配置与阶段输出共用受限 Schema 校验。"""

    def check_schema(self, schema: dict[str, object]) -> None:
        serialized = json.dumps(schema)
        if len(serialized) > 128_000:
            raise DomainError(422, "schema exceeds size limit")

        def references(value: object, depth: int = 0) -> None:
            if depth > 64:
                raise DomainError(422, "schema nesting is too deep")
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"$ref", "$dynamicRef"} and (
                        not isinstance(item, str) or not item.startswith("#")
                    ):
                        raise DomainError(422, "remote schema references are not allowed")
                    references(item, depth + 1)
            elif isinstance(value, list):
                for item in value:
                    references(item, depth + 1)

        references(schema)
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as error:
            raise DomainError(422, "invalid JSON Schema") from error

    def validate(self, value: object, schema: dict[str, object]) -> None:
        self.check_schema(schema)
        try:
            Draft202012Validator(schema).validate(value)
        except (ValidationError, Unresolvable, RecursionError) as error:
            # 不回显 value，writeOnly 配置校验失败时也不能泄漏凭据。
            raise DomainError(422, "value does not match configured schema") from error

    def validate_tool_arguments(self, value: object, schema: dict[str, object]) -> None:
        """工具参数仅报告字段路径与规则名，供模型纠正；不返回输入、配置值或验证器原文。"""
        self.check_schema(schema)
        try:
            Draft202012Validator(schema).validate(value)
        except ValidationError as error:
            path = ".".join(str(part)[:80] for part in list(error.absolute_path)[:8]) or "$"
            rule = str(error.validator)[:40]
            raise DomainError(
                422,
                f"工具参数字段 {path} 不符合 {rule} 规则，请按照工具字段说明修正后提交。",
                "tool_arguments_invalid",
            ) from None
        except (Unresolvable, RecursionError) as error:
            raise DomainError(422, "value does not match configured schema") from error

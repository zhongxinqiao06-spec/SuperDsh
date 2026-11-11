"""固定 DSH 交互与公开通知合同的双向转换，不替用户决定任何选项。"""

from app.infrastructure.errors import DomainError
from app.integrations.dsh.protocol import contract


def record(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def runtime_error_notice(params: dict[str, object]) -> dict[str, object]:
    """保留旧设备 runtime.error 转通知合同，运行错误不能作为未来未知消息被忽略。"""

    def text(key: str, fallback: str) -> str:
        value = params.get(key)
        return value if isinstance(value, str) else fallback

    message = text("message", "The runtime reported an error.")
    return {
        **params,
        "noticeId": text("noticeId", "runtime_error_" + str(params.get("sessionId", "undefined"))),
        "type": "notification",
        "source": {
            "runtime": params.get("runtime"),
            "component": "runtime",
            "operationId": params.get("operationId") or None,
        },
        "title": text("title", "Runtime error"),
        "message": message,
        "severity": "error",
        "status": text("status", "open"),
        "context": {
            "error": {"code": "runtime_error", "message": message, "details": params},
            "reason": "runtime_error",
        },
    }


def notice_view(value: dict[str, object]) -> dict[str, object]:
    """保留来源原始细节，并提供桌面/安卓既有 inputRequest 视图。"""
    # 固定 Host 使用 noticeId/actionId，旧设备可能仍提供 id；统一展示身份但不删除线协议字段。
    raw_actions = value.get("actions", [])
    value = {
        **value,
        "id": value.get("noticeId", value.get("id")),
        "actions": [
            {**record(action), "id": record(action).get("actionId", record(action).get("id"))}
            for action in raw_actions
        ]
        if isinstance(raw_actions, list)
        else [],
    }
    kind = value.get("interactionKind")
    if kind not in {"approval", "user_question"}:
        return value
    actions = value.get("actions", [])
    if not isinstance(actions, list):
        actions = []
    if kind == "approval":
        return {
            **value,
            "interactionType": "approval",
            "actions": [
                {**record(action), "input": {"schema": {"type": "object"}, "uiSchema": {}}}
                for action in actions
            ],
        }
    questions = record(value.get("details")).get("questions", [])
    if not isinstance(questions, list):
        raise DomainError(502, "invalid runtime interaction")
    converted = []
    for raw in questions:
        question = record(raw)
        options = question.get("options", [])
        if not isinstance(options, list):
            raise DomainError(502, "invalid runtime options")
        values = [
            {
                "id": "option-" + str(index),
                "label": record(option).get("label"),
                "description": record(option).get("description"),
            }
            for index, option in enumerate(options)
        ]
        intent = record(question.get("intent"))
        approval = next(
            (option["id"] for option in values if option["label"] == intent.get("approve")), None
        )
        converted.append(
            {
                "id": question.get("id"),
                "prompt": question.get("question"),
                "detail": question.get("detail"),
                "multiple": question.get("multiSelect") is True,
                "allowCustom": True,
                "options": values,
                **(
                    {"intent": {"kind": "plan-review", "approveOptionId": approval}}
                    if intent.get("kind") == "plan-review" and approval
                    else {}
                ),
            }
        )
    schema_version = contract().get("inputRequestSchemaVersion")
    if not isinstance(schema_version, int):
        raise DomainError(503, "input request protocol metadata is unavailable")
    return {
        **value,
        "interactionType": "input_request",
        "actions": [
            {
                **record(action),
                "input": {
                    "schema": {"type": "object"},
                    "uiSchema": {
                        "component": "inputRequest",
                        "version": schema_version,
                        "questions": converted,
                    },
                },
            }
            for action in actions
        ],
    }


def response_input(notice: dict[str, object], value: dict[str, object]) -> dict[str, object]:
    """公开选项 ID 只能映射到原始问题标签，模型注入的 label 不参与转换。"""
    answers = value.get("answers")
    if not isinstance(answers, dict):
        return value
    raw_questions = record(notice.get("details")).get("questions")
    if not isinstance(raw_questions, list):
        return value
    if set(answers) != {str(record(raw).get("id", "")) for raw in raw_questions}:
        raise DomainError(422, "all questions must be answered")
    result = []
    for raw in raw_questions:
        question = record(raw)
        answer = record(answers.get(str(question.get("id", ""))))
        choices = answer.get("optionIds", [])
        options = question.get("options", [])
        if not isinstance(choices, list) or not isinstance(options, list):
            raise DomainError(422, "invalid input response")
        mapping = {
            "option-" + str(index): record(option).get("label")
            for index, option in enumerate(options)
        }
        if any(not isinstance(choice, str) or choice not in mapping for choice in choices):
            raise DomainError(422, "unknown response option")
        custom = answer.get("customText", "")
        if not isinstance(custom, str) or set(answer) - {"optionIds", "customText"}:
            raise DomainError(422, "invalid input response")
        if (
            len(choices) != len(set(choices))
            or not choices
            and not custom.strip()
            or question.get("multiSelect") is not True
            and (len(choices) > 1 or choices and custom.strip())
        ):
            raise DomainError(422, "invalid input response")
        result.append(
            {
                "id": question.get("id"),
                "selected": [mapping[str(choice)] for choice in choices],
                **({"custom": custom.strip()} if custom.strip() else {}),
            }
        )
    return {"answers": result}

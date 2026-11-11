"""智能体发布前置检查；配置通过不等于执行引擎或外部模型已验证。"""

from typing import cast


def check_readiness(
    definition: dict[str, object],
    resources: dict[str, list[dict[str, object]]],
    assets: list[dict[str, object]],
) -> dict[str, object]:
    """按声明资源检查组合，不按智能体名称或内置办公助手分支。"""
    checks: list[dict[str, str]] = []

    def add(identifier: str, status: str, message: str) -> None:
        checks.append({"id": identifier, "status": status, "message": message})

    tool_ids = cast(list[str], definition.get("toolIds", []))
    skill_ids = cast(list[str], definition.get("skillIds", []))
    policy = definition.get("skillPolicy")
    if isinstance(policy, dict) and policy.get("mode") != "legacy":
        programs = [
            skill
            for skill in resources["skills"]
            if skill["id"] in skill_ids and skill.get("enabled") and skill.get("program")
        ]
        valid = bool(programs) and (
            policy.get("mode") != "fixed"
            or any(skill["id"] == policy.get("fixedSkillId") for skill in programs)
        )
        add(
            "skill-policy",
            "pass" if valid else "error",
            "已关联阶段技能，工具与校验由服务端约束"
            if valid
            else "自动或固定策略需要关联有效阶段技能",
        )
    for identifier in tool_ids:
        tool = next((item for item in resources["tools"] if item["id"] == identifier), None)
        add(
            "tool:" + identifier,
            "pass" if tool and tool.get("enabled") else "error",
            "工具已启用：" + str(tool["name"])
            if tool and tool.get("enabled")
            else "工具不可用：" + identifier,
        )
    for identifier in skill_ids:
        skill = next((item for item in resources["skills"] if item["id"] == identifier), None)
        if not skill or not skill.get("enabled"):
            add("skill:" + identifier, "error", "技能不可用：" + identifier)
            continue
        missing = [
            str(value)
            for value in cast(list[str], skill.get("requiredToolIds", []))
            if value not in tool_ids
        ]
        add(
            "skill:" + identifier,
            "error" if missing else "pass",
            str(skill["name"])
            + (" 缺少必需工具：" + "、".join(missing) if missing else " 配置有效"),
        )
    for key, field, success, warning in [
        ("purpose", "description", "已说明用途与受众", "建议补充用途与受众"),
        ("prompts", "recommendedPrompts", "已提供推荐指令", "建议添加推荐指令，方便真实试用"),
        ("input", "inputRequirements", "已说明输入要求", "建议说明输入文件、格式和必要字段"),
        ("output", "outputExamples", "已说明输出示例", "建议说明输出内容和可修改范围"),
    ]:
        add(
            key,
            "pass" if definition.get(field) else "warning",
            success if definition.get(field) else warning,
        )
    # 配置 ID 是持久资源身份；可选工具的运行前提由其 Schema 与执行契约校验，
    # 不根据预设工具名称推断知识库或模板要求，定制工具与内置示例走同一检查链。
    if not tool_ids:
        add("tools", "warning", "未关联工具，只能进行普通模型对话")
    add(
        "trial",
        "warning",
        "配置检查不代表模型或运行环境验证通过；发布后从试用进入工作台，手动发送真实任务",
    )
    errors = [item["message"] for item in checks if item["status"] == "error"]
    return {
        "ready": not errors,
        "checks": checks,
        "errors": errors,
        "warnings": [item["message"] for item in checks if item["status"] == "warning"],
    }

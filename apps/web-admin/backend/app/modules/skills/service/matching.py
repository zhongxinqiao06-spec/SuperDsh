"""技能规则匹配是确定性筛选，不发起模型回合或第二执行队列。"""

import unicodedata


def match_skills(
    skills: list[dict[str, object]],
    request: str,
    extensions: list[str] | None = None,
    fixed_skill_id: str | None = None,
) -> list[dict[str, object]]:
    """返回所有有效程序的评分，负分候选附明确排除原因。"""
    query = unicodedata.normalize("NFKC", request).lower()
    output: list[dict[str, object]] = []
    for skill in skills:
        program = skill.get("program")
        if (
            not skill.get("enabled")
            or not isinstance(program, dict)
            or (fixed_skill_id and skill["id"] != fixed_skill_id)
        ):
            continue
        rules = program.get("match", {})
        if not isinstance(rules, dict):
            continue

        def terms(key: str, current: dict[str, object] = rules) -> list[str]:
            value = current.get(key, [])
            return (
                [item for item in value if isinstance(item, str)] if isinstance(value, list) else []
            )

        excluded = any(term.lower() in query for term in terms("excludePhrases"))
        input_match = (
            not terms("inputExtensions")
            or not extensions
            or any(ext in terms("inputExtensions") for ext in extensions)
        )
        reasons = [f"需求包含“{term}”" for term in terms("phrases") if term.lower() in query]
        output.append(
            {
                "id": skill["id"],
                "name": skill["name"],
                "description": skill.get("description", ""),
                "score": -1
                if excluded or not input_match
                else len(reasons) * 10 + (100 if fixed_skill_id else 0),
                "reasons": ["命中排除条件"]
                if excluded
                else ["输入格式不适用"]
                if not input_match
                else reasons,
                "outputTypes": terms("outputTypes"),
                "examples": terms("examples"),
            }
        )
    return sorted(output, key=lambda item: (-int(str(item["score"])), str(item["id"])))

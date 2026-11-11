"""技能引用图的纯验证入口，可在资源持有所有者事务锁后调用。"""

from pydantic import ValidationError

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.validation import object_schema
from app.modules.skills.entity.vo.management import SkillProgramInput


def validate_skill_graph(
    payload: dict[str, object],
    identifier: str,
    existing: dict[str, dict[str, object]],
) -> None:
    """校验候选和全部可达技能的授权、阶段及循环，不执行网络或持久化。"""
    skills = {**existing, identifier: {**payload, "enabled": True}}
    checked: set[str] = set()

    def visit(current: str, path: set[str]) -> None:
        if current in path or len(path) >= 20:
            raise DomainError(422, "技能阶段引用形成循环或层级过深")
        if current in checked:
            return
        skill = skills.get(current)
        if not skill or not skill.get("enabled", True):
            raise DomainError(422, "引用技能不存在或已停用")
        required = skill.get("requiredToolIds", [])
        if not isinstance(required, list):
            raise DomainError(422, "技能工具授权格式无效")
        granted = set(str(item) for item in required)
        for field in ("program", "programDraft"):
            raw = skill.get(field)
            if raw is None:
                continue
            if not isinstance(raw, dict):
                raise DomainError(422, "技能程序格式无效")
            stages = raw.get("stages")
            if not isinstance(stages, list) or any(not isinstance(stage, dict) for stage in stages):
                raise DomainError(422, "技能阶段格式无效")
            # 早期资源接口省略展示文案；验证补标签但不改写保存的程序或执行指令。
            normalized = [
                {
                    **stage,
                    "name": stage.get("name") or str(stage.get("id", "")),
                    "instructions": stage.get("instructions") or "执行已配置阶段",
                }
                for stage in stages
            ]
            try:
                program = SkillProgramInput.model_validate({**raw, "stages": normalized})
            except ValidationError as error:
                raise DomainError(422, "技能阶段、确认顺序或校验器配置无效") from error
            for stage in program.stages:
                object_schema(stage.outputSchema)
                if not set([*stage.toolIds, *stage.inspectToolIds]).issubset(granted):
                    raise DomainError(422, "阶段工具必须在技能授权范围内")
                if stage.skillId:
                    target = skills.get(stage.skillId)
                    if not target or not target.get("enabled", True):
                        raise DomainError(422, "引用技能不存在或已停用")
                    target_tools = target.get("requiredToolIds", [])
                    if not isinstance(target_tools, list) or not set(
                        map(str, target_tools)
                    ).issubset(granted):
                        raise DomainError(422, "引用技能的工具超出当前技能授权")
                    visit(stage.skillId, path | {current})
        checked.add(current)

    visit(identifier, set())

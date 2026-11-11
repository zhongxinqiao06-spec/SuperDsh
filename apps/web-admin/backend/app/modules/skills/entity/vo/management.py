"""技能管理输入合同；阶段版本属于业务契约，不是应用发布版本。"""

from typing import Literal, Self

from pydantic import Field, model_validator

from app.modules.identity.entity.vo.dto import InputModel

StageCheck = Literal["schema", "sources", "plan", "artifact", "rendered-quality"]


def default_output_schema() -> dict[str, object]:
    """缺省阶段输出仍要求对象，不能省略完整校验。"""
    return {"type": "object"}


def default_checks() -> list[StageCheck]:
    """每个新阶段默认启用Schema验证。"""
    return ["schema"]


class MatchRules(InputModel):
    """匹配只使用用户请求和文件扩展名，不将附件内容作为指令。"""

    phrases: list[str] = Field(default_factory=list, max_length=30)
    excludePhrases: list[str] = Field(default_factory=list, max_length=30)
    inputExtensions: list[str] = Field(default_factory=list, max_length=30)
    outputTypes: list[str] = Field(default_factory=list, max_length=30)
    examples: list[str] = Field(default_factory=list, max_length=10)


class StageDefinition(InputModel):
    """阶段授权工具与校验器均显式声明，不由模型输出提升权限。"""

    id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$")
    name: str = Field(min_length=1, max_length=100)
    instructions: str = Field(min_length=1, max_length=6000)
    skillId: str | None = Field(default=None, max_length=160)
    operation: Literal["submit", "inspect", "prepare", "execute", "review"]
    toolIds: list[str] = Field(default_factory=list, max_length=30)
    inspectToolIds: list[str] = Field(default_factory=list, max_length=30)
    outputSchema: dict[str, object] = Field(default_factory=default_output_schema)
    checks: list[StageCheck] = Field(default_factory=default_checks, max_length=30)


class SkillProgramInput(InputModel):
    """已发布和草稿程序使用同一校验，保留 prepare/execute 相邻约束。"""

    schemaVersion: Literal[1] = 1
    match: MatchRules = Field(default_factory=MatchRules)
    stages: list[StageDefinition] = Field(min_length=1, max_length=20)
    maxRevisions: int = Field(default=2, ge=0, le=5)
    timeoutSeconds: int = Field(default=600, ge=30, le=3600)

    @model_validator(mode="after")
    def ordered_stages(self) -> Self:
        """生成必须消费紧邻且工具匹配的方案，不允许跨阶段挪用确认。"""
        if len({stage.id for stage in self.stages}) != len(self.stages):
            raise ValueError("阶段标识不能重复")
        for index, stage in enumerate(self.stages):
            if stage.operation in {"inspect", "prepare", "execute"} and not stage.toolIds:
                raise ValueError("工具阶段必须指定授权工具")
            if stage.inspectToolIds and stage.operation != "submit":
                raise ValueError("辅助检查工具只能用于提交阶段")
            if "sources" in stage.checks and stage.operation != "inspect":
                raise ValueError("资料证据必须来自检查阶段")
            if "plan" in stage.checks and stage.operation != "prepare":
                raise ValueError("方案证据必须来自准备阶段")
            if stage.operation == "prepare" and (
                index + 1 == len(self.stages) or self.stages[index + 1].operation != "execute"
            ):
                raise ValueError("方案确认后必须配置生成阶段")
            if stage.operation == "execute" and (
                index == 0
                or self.stages[index - 1].operation != "prepare"
                or not set(stage.toolIds).issubset(self.stages[index - 1].toolIds)
            ):
                raise ValueError("生成阶段必须紧接同一工具的方案确认阶段")
        return self


class SkillReference(InputModel):
    """引用绑定资料内容哈希，后续文件变化不能替换已确认输入。"""

    path: str = Field(min_length=1, max_length=240)
    assetId: str = Field(min_length=1, max_length=160)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class SkillInput(InputModel):
    """文本编辑保留未提交的引用和程序；明确 null 才清空草稿。"""

    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    enabled: bool = True
    instructions: str = Field(min_length=1, max_length=12000)
    requiredToolIds: list[str] = Field(default_factory=list, max_length=100)
    version: int | None = Field(default=None, ge=1)
    program: SkillProgramInput | None = None
    programDraft: SkillProgramInput | None = None
    references: list[SkillReference] | None = Field(default=None, max_length=100)
    packageSha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class SkillMatchInput(InputModel):
    """管理页匹配试验，返回规则评分及排除原因。"""

    request: str = Field(min_length=1, max_length=12000)
    skillIds: list[str] = Field(default_factory=list, max_length=100)
    extensions: list[str] = Field(default_factory=list, max_length=100)


class ResourceVersionInput(InputModel):
    """修改必须携带当前版本，历史版本字段不替代当前并发栅栏。"""

    version: int = Field(ge=1)
    sourceVersion: int | None = Field(default=None, ge=1)


class SkillImportInput(InputModel):
    """技能包只接收数据ZIP；可执行代码必须走扩展安装权限。"""

    contentBase64: str = Field(min_length=1, max_length=16 * 1024 * 1024)
    id: str | None = Field(default=None, max_length=160)
    version: int | None = Field(default=None, ge=1)
    requiredToolIds: list[str] | None = Field(default=None, max_length=100)


class ExtensionSkillInput(InputModel):
    """从已安装且授权的固定扩展版本导入资料技能。"""

    sourceId: str = Field(min_length=1, max_length=100)
    sourceVersion: str = Field(min_length=1, max_length=100)
    skillId: str = Field(min_length=1, max_length=100)
    id: str | None = Field(default=None, max_length=160)
    version: int | None = Field(default=None, ge=1)
    requiredToolIds: list[str] | None = Field(default=None, max_length=100)

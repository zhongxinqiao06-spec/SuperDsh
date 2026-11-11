"""基础资源编辑 DTO，配置内容由实现提供的 JSON Schema 再校验。"""

from pydantic import Field

from app.modules.identity.entity.vo.dto import InputModel


class ResourceInput(InputModel):
    """工具实现、配置、技能正文及组合引用保持分离。"""

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    enabled: bool = True
    published: bool = False
    version: int | None = Field(default=None, ge=1)
    instructions: str = Field(default="", max_length=100000)
    requiredToolIds: list[str] = Field(default_factory=list, max_length=100)
    toolIds: list[str] = Field(default_factory=list, max_length=100)
    skillIds: list[str] = Field(default_factory=list, max_length=100)
    assetIds: list[str] = Field(default_factory=list, max_length=100)
    settings: dict[str, object] = Field(default_factory=dict)
    implementation: dict[str, object] | None = None
    manifest: dict[str, object] | None = None
    program: dict[str, object] | None = None
    programDraft: dict[str, object] | None = None


class BindingInput(InputModel):
    """会话绑定只接受资源标识，不接收伪造的冻结快照。"""

    agentDefinitionId: str = Field(max_length=80)

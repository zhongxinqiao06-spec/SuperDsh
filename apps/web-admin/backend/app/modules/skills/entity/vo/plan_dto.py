"""方案编辑只能提交当前持久版本和结构化文档，不接受批准凭证。"""

from pydantic import BaseModel, ConfigDict, Field


class PlanRevisionInput(BaseModel):
    """客户端不能修改收据身份、绑定或执行状态。"""

    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    document: dict[str, object]

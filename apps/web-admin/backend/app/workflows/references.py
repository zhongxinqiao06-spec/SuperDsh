"""可选阶段状态分支，不拥有模型循环、执行队列或工具副作用。"""

from typing import Literal, TypedDict

from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph

from app.infrastructure.errors import DomainError


class TransitionReference(TypedDict):
    """图只接受业务表的稳定引用，方案、凭据和工具结果留在原表。"""

    run_id: str
    version: int
    event: str
    state: str


def classify(value: TransitionReference) -> Literal["waiting", "terminal", "active"]:
    """等待用户与执行状态分开，终态不再授权工具调用。"""
    if value["state"] in {"waiting-user", "interrupted"}:
        return "waiting"
    if value["state"] in {"completed", "failed", "cancelled"}:
        return "terminal"
    if value["state"] in {"running", "executing", "needs-revision"}:
        return "active"
    raise DomainError(409, "unsupported workflow state")


def validate_reference(value: TransitionReference) -> TransitionReference:
    """检查事件与目标状态一致，不接受矛盾的执行/等待引用。"""
    required = {
        "plan-prepared": "waiting-user",
        "tool-submitted": "executing",
        "platform-restarted": "interrupted",
        "cancelled": "cancelled",
        "revised": "running",
    }
    if (
        not value["run_id"]
        or value["version"] < 1
        or (value["event"] in required and required[value["event"]] != value["state"])
    ):
        raise DomainError(409, "workflow reference conflicts with business state")
    return value


class LangGraphReferences:
    """短纯计算图；引用由业务事件事务持久化，重启不重放执行。"""

    def __init__(self) -> None:
        graph = StateGraph(TransitionReference)
        graph.add_node("validate", RunnableLambda(validate_reference))
        graph.add_edge(START, "validate")
        graph.add_conditional_edges(
            "validate", classify, {"waiting": END, "terminal": END, "active": END}
        )
        self.graph = graph.compile()

    async def record(self, run_id: str, version: int, event: str, state: str) -> None:
        """写入前验证稳定引用，不执行网络或创建第二持久状态库。"""
        await self.graph.ainvoke(
            {"run_id": run_id, "version": version, "event": event, "state": state}
        )

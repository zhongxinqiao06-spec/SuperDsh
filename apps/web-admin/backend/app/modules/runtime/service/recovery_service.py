"""仅供持有部署管理权限的命令行显式恢复，不作为浏览器或自动接管入口。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database
from app.infrastructure.runtime_ownership import PostgresOwnershipProvider
from app.integrations.dsh.process_identity import machine_identity, process_is_alive
from app.integrations.dsh.protocol import Fields, RuntimeFailure
from app.modules.runtime.dao.projection import ProjectionDao
from app.modules.runtime.entity.do.models import RuntimeExecutionFence


class RuntimeRecoveryService:
    """检查不持锁、不启动 Host；释放依赖运维退出证明及同用户运行锁。"""

    def __init__(self, database: Database) -> None:
        self.database = database
        self.ownership = PostgresOwnershipProvider(database.engine)

    @staticmethod
    def _validate(value: str, maximum: int) -> None:
        if (
            not value
            or len(value) > maximum
            or value != value.strip()
            or any(ord(character) < 32 for character in value)
            or value == "__platform_supervisor__"
        ):
            raise RuntimeFailure("runtime_recovery_input_invalid", "运行恢复身份参数无效", 422)

    @staticmethod
    def _view(owner: str, row: RuntimeExecutionFence | None) -> Fields:
        current = machine_identity()
        state = "absent"
        if row is not None:
            if row.machine != current:
                state = "different_machine_unverified"
            elif row.pid is None:
                state = "pid_unrecorded"
            else:
                state = (
                    "local_process_alive" if process_is_alive(row.pid) else "local_process_exited"
                )
        return {
            "owner": owner,
            "fence": (
                {"generation": row.generation, "machine": row.machine, "pid": row.pid}
                if row is not None
                else None
            ),
            "currentMachine": current,
            "processState": state,
        }

    async def inspect(self, owner: str) -> Fields:
        """只读返回指定用户栅栏；不同机器/PID 命名空间只能标记为待人工核实。"""
        self._validate(owner, 128)
        async with self.database.sessions() as session:
            return self._view(owner, await ProjectionDao(session).fence(owner))

    async def release(
        self,
        owner: str,
        *,
        generation: str,
        machine: str,
        pid: int | None,
        confirmed_exited: bool,
    ) -> Fields:
        """运维确认旧执行者已退出后按完整快照释放；活进程、锁争用和变化均拒绝。"""
        self._validate(owner, 128)
        self._validate(generation, 64)
        self._validate(machine, 256)
        if pid is not None and (isinstance(pid, bool) or pid <= 0):
            raise RuntimeFailure("runtime_recovery_input_invalid", "旧执行进程 PID 无效", 422)
        if confirmed_exited is not True:
            raise RuntimeFailure(
                "runtime_recovery_confirmation_required", "必须先核实原执行者已退出", 409
            )
        # 查询、CAS 和提交使用同一持锁连接；不能用独立连接或在失锁后重试写入。
        async with self.ownership.recovery_transaction(owner) as connection:
            async with AsyncSession(bind=connection, expire_on_commit=False) as session:
                dao = ProjectionDao(session)
                row = await dao.fence(owner)
                if row is None or (row.generation, row.machine, row.pid) != (
                    generation,
                    machine,
                    pid,
                ):
                    raise RuntimeFailure(
                        "runtime_recovery_conflict", "执行栅栏已变化，请重新检查并核实", 409
                    )
                observed = self._view(owner, row)
                if observed["processState"] == "local_process_alive":
                    raise RuntimeFailure(
                        "runtime_recovery_process_alive", "原执行进程仍存活，拒绝释放栅栏", 409
                    )
                if not await dao.delete_fence_if_matches(owner, generation, machine, pid):
                    raise RuntimeFailure(
                        "runtime_recovery_conflict", "执行栅栏已变化，请重新检查并核实", 409
                    )
        # 必须在事务提交成功后返回；任何连接/提交异常都不能报告已恢复。
        return {"status": "released", "previous": observed}

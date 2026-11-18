"""独立 PostgreSQL 验证恢复的运行锁、完整快照及回滚，不启动 Host 或模型。"""

import os
from typing import cast

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from app.infrastructure.configuration import Settings
from app.infrastructure.database import Database
from app.infrastructure.runtime_ownership import PostgresOwnershipProvider
from app.integrations.dsh.process_identity import machine_identity
from app.integrations.dsh.protocol import RuntimeFailure
from app.modules.runtime.dao.projection import ProjectionDao
from app.modules.runtime.entity.do.models import RuntimeExecutionFence
from app.modules.runtime.service import recovery_service
from app.modules.runtime.service.recovery_service import RuntimeRecoveryService
from app.runtime_recovery import parse_arguments

OWNER = "synthetic-recovery-owner"
GENERATION = "synthetic-old-generation"
MACHINE = "Linux:synthetic-old-container:pid:[12345]"


def test_recovery_cli_defaults_to_inspection() -> None:
    args = parse_arguments(["--owner", OWNER])
    assert not args.release
    assert not args.confirm_executor_exited


@pytest.mark.parametrize(
    "arguments",
    [
        ["--release"],
        ["--release", "--confirm-executor-exited"],
        ["--expected-generation", GENERATION],
        ["--confirm-executor-exited"],
        [
            "--release",
            "--expected-generation",
            GENERATION,
            "--expected-machine",
            MACHINE,
            "--expected-pid",
            "53",
        ],
        [
            "--release",
            "--expected-generation",
            GENERATION,
            "--expected-machine",
            MACHINE,
            "--expected-pid",
            "0",
            "--confirm-executor-exited",
        ],
    ],
)
def test_recovery_cli_rejects_incomplete_confirmation(arguments: list[str]) -> None:
    with pytest.raises(SystemExit) as error:
        parse_arguments(["--owner", OWNER, *arguments])
    assert error.value.code == 2


async def test_recovery_lock_snapshot_and_rollback(
    platform_configuration: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(platform_configuration.database_url)
    service = RuntimeRecoveryService(database)
    ownership = PostgresOwnershipProvider(database.engine)

    async def set_fence(
        generation: str = GENERATION, machine: str = MACHINE, pid: int | None = 53
    ) -> None:
        async with database.sessions.begin() as session:
            row = await session.get(RuntimeExecutionFence, OWNER)
            if row is None:
                session.add(
                    RuntimeExecutionFence(
                        owner=OWNER, generation=generation, machine=machine, pid=pid
                    )
                )
            else:
                row.generation, row.machine, row.pid = generation, machine, pid

    async def release(
        generation: str = GENERATION,
        machine: str = MACHINE,
        pid: int | None = 53,
        confirmed: bool = True,
    ) -> dict:
        return await service.release(
            OWNER, generation=generation, machine=machine, pid=pid, confirmed_exited=confirmed
        )

    try:
        await set_fence()

        def never_check_remote_pid(pid: int) -> bool:
            raise AssertionError("不能用本机 PID 表验证旧容器")

        with monkeypatch.context() as patch:
            patch.setattr(recovery_service, "process_is_alive", never_check_remote_pid)
            inspected = await service.inspect(OWNER)
        assert inspected["processState"] == "different_machine_unverified"
        assert inspected["fence"] == {"generation": GENERATION, "machine": MACHINE, "pid": 53}

        lease = await ownership.acquire(OWNER)
        try:
            assert (await service.inspect(OWNER))["fence"] == inspected["fence"]
            with pytest.raises(RuntimeFailure) as occupied:
                await release()
            assert occupied.value.code == "runtime_owned_elsewhere"
        finally:
            await lease.release()
        async with ownership.recovery_transaction(OWNER):
            with pytest.raises(RuntimeFailure) as occupied:
                await ownership.acquire(OWNER)
            assert occupied.value.code == "runtime_owned_elsewhere"

        with pytest.raises(RuntimeFailure) as unconfirmed:
            await release(confirmed=False)
        assert unconfirmed.value.code == "runtime_recovery_confirmation_required"
        for generation, machine, pid in [
            ("changed-generation", MACHINE, 53),
            (GENERATION, "changed-machine", 53),
            (GENERATION, MACHINE, 54),
            (GENERATION, MACHINE, None),
        ]:
            with pytest.raises(RuntimeFailure) as stale:
                await release(generation, machine, pid)
            assert stale.value.code == "runtime_recovery_conflict"
            async with database.sessions.begin() as session:
                assert not await ProjectionDao(session).delete_fence_if_matches(
                    OWNER, generation, machine, pid
                )
        assert (await service.inspect(OWNER))["fence"] == inspected["fence"]

        await set_fence(machine=machine_identity(), pid=os.getpid())
        with pytest.raises(RuntimeFailure) as alive:
            await release(machine=machine_identity(), pid=os.getpid())
        assert alive.value.code == "runtime_recovery_process_alive"
        await set_fence()

        delete = ProjectionDao.delete_fence_if_matches

        async def fail_after_delete(
            dao: ProjectionDao, owner: str, generation: str, machine: str, pid: int | None
        ) -> bool:
            assert await delete(dao, owner, generation, machine, pid)
            raise RuntimeError("synthetic failure before commit")

        with monkeypatch.context() as patch:
            patch.setattr(ProjectionDao, "delete_fence_if_matches", fail_after_delete)
            with pytest.raises(RuntimeError, match="before commit"):
                await release()
        assert (await service.inspect(OWNER))["fence"] == inspected["fence"]

        # 真实终止持锁连接：未提交删除必须回滚，不能重连后继续删除或伪报成功。
        with pytest.raises(SQLAlchemyError):
            async with ownership.recovery_transaction(OWNER) as connection:
                backend_pid = cast(int, await connection.scalar(text("SELECT pg_backend_pid()")))
                await connection.execute(
                    text("DELETE FROM runtime_execution_fences WHERE owner = :owner"),
                    {"owner": OWNER},
                )
                async with database.engine.begin() as terminator:
                    assert await terminator.scalar(
                        text("SELECT pg_terminate_backend(:pid)"), {"pid": backend_pid}
                    )
                await connection.execute(text("SELECT 1"))
        assert (await service.inspect(OWNER))["fence"] == inspected["fence"]

        await set_fence(pid=None)
        with pytest.raises(RuntimeFailure) as attached:
            await release()
        assert attached.value.code == "runtime_recovery_conflict"
        assert (await release(pid=None))["status"] == "released"
        assert (await service.inspect(OWNER))["processState"] == "absent"
        await set_fence(generation="successor-generation")
        with pytest.raises(RuntimeFailure) as successor:
            await release()
        assert successor.value.code == "runtime_recovery_conflict"
        async with database.sessions() as session:
            assert (
                await session.scalar(select(RuntimeExecutionFence.generation))
                == "successor-generation"
            )
        assert (await release(generation="successor-generation"))["status"] == "released"
        with pytest.raises(RuntimeFailure) as missing:
            await release(generation="successor-generation")
        assert missing.value.code == "runtime_recovery_conflict"
    finally:
        await database.close()

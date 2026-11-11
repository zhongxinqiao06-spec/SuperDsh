"""投影原始事实和 checkpoint 原子持久化，成功提交后由连接器 ACK。"""

from __future__ import annotations

import re

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.integrations.dsh.protocol import Fields, Json, RuntimeFailure, contract, fields
from app.modules.runtime.dao.projection import ProjectionDao
from app.modules.runtime.entity.do.models import (
    RuntimeBatch,
    RuntimeCheckpoint,
    RuntimeExecutionFence,
    RuntimeReceipt,
)


class SqlProjectionStore:
    """只做短事务，绝不持有数据库事务等待引擎或用户确认。"""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions
        self.metadata = contract()

    async def commit(self, owner: str, batch: Fields) -> Fields:
        """批次去重、checkpoint 更新和投影事实在同一事务内提交。"""
        stream, sequence = batch.get("streamId"), batch.get("batchSeq")
        operations = batch.get("operations")
        if (
            not isinstance(stream, str)
            or not isinstance(sequence, int)
            or batch.get("projectionVersion") != self.metadata["projectionVersion"]
            or not isinstance(operations, list)
            or not operations
        ):
            raise RuntimeFailure("invalid_projection", "运行时投影批次无效")
        async with self.sessions() as session, session.begin():
            dao = ProjectionDao(session)
            existing = await dao.batch(owner, stream, sequence)
            if existing is not None:
                if existing.payload != batch:
                    raise RuntimeFailure("projection_replay_conflict", "运行时批次重放不一致")
                return existing.acknowledgement
            ack: Fields = {"streamId": stream, "batchSeq": sequence}
            for raw in operations:
                operation = fields(raw)
                kind = operation.get("kind")
                if not isinstance(kind, str):
                    raise RuntimeFailure("invalid_projection", "投影操作缺少类型")
                if kind.startswith("checkpoint."):
                    external = operation.get("externalSessionId")
                    if not isinstance(external, str) or not external:
                        raise RuntimeFailure("invalid_checkpoint", "checkpoint 缺少会话身份")
                    row = await dao.checkpoint(owner, external)
                    if kind == "checkpoint.load":
                        ack["checkpoint"] = row.payload if row else None
                    elif kind == "checkpoint.delete":
                        if row:
                            await dao.delete_checkpoint(row)
                    elif kind == "checkpoint.save":
                        checkpoint = fields(operation.get("checkpoint"))
                        through = checkpoint.get("throughSeq")
                        if (
                            checkpoint.get("version") != self.metadata["checkpointVersion"]
                            or checkpoint.get("projectionVersion")
                            != self.metadata["projectionVersion"]
                            or not isinstance(through, int)
                            or through < -1
                            or not isinstance(checkpoint.get("settled"), bool)
                            or re.fullmatch(r"[a-f0-9]{64}", str(checkpoint.get("historyHash")))
                            is None
                        ):
                            raise RuntimeFailure("invalid_checkpoint", "checkpoint 无效")
                        if row:
                            row.payload = checkpoint
                        else:
                            dao.add(
                                RuntimeCheckpoint(
                                    owner=owner, external_session=external, payload=checkpoint
                                )
                            )
                    else:
                        raise RuntimeFailure("invalid_projection", "未知 checkpoint 操作")
                elif kind not in {
                    "snapshot.begin",
                    "snapshot.items",
                    "snapshot.commit",
                    "snapshot.abort",
                    "notifications",
                    "workspace.inventory",
                }:
                    raise RuntimeFailure("invalid_projection", "未知投影操作")
            dao.add(
                RuntimeBatch(
                    owner=owner,
                    stream=stream,
                    sequence=sequence,
                    payload=batch,
                    acknowledgement=ack,
                )
            )
            return ack

    async def events(self, owner: str, after: int = 0) -> list[Fields]:
        """按用户与持久游标读取有限页事件，不暴露其他用户的投影。"""
        async with self.sessions() as session:
            rows = await ProjectionDao(session).events(owner, after)
            return [{"cursor": row.id, "batch": row.payload} for row in rows]

    async def replay(self, owner: str, identifier: str, digest: str) -> tuple[bool, Json]:
        """仅查询已有收据；解析动态默认配置前先重放，不占用尚未发送的请求。"""
        async with self.sessions() as session:
            row = await ProjectionDao(session).receipt(owner, identifier)
            if row is None:
                return False, None
            return True, self._completed_result(row, digest)

    @staticmethod
    def _completed_result(row: RuntimeReceipt, digest: str) -> Json:
        if row.digest != digest:
            raise RuntimeFailure("idempotency_conflict", "相同请求标识的参数不一致", 409)
        if row.state != "completed":
            raise RuntimeFailure(
                "session_create_outcome_unknown", "操作结果未知，请先核对会话状态", 409
            )
        return row.result

    async def reserve(self, owner: str, identifier: str, digest: str) -> tuple[bool, Json]:
        """发送前写入未知态；同键异参冲突，已完成重用，未知态不重发。"""
        async with self.sessions() as session:
            try:
                ProjectionDao(session).add(
                    RuntimeReceipt(
                        owner=owner,
                        identifier=identifier,
                        digest=digest,
                        state="outcome_unknown",
                        result=None,
                    )
                )
                await session.commit()
                return True, None
            except IntegrityError:
                await session.rollback()
            row = await ProjectionDao(session).receipt(owner, identifier)
            if row is None:
                raise RuntimeFailure("idempotency_conflict", "相同请求标识的参数不一致", 409)
            return False, self._completed_result(row, digest)

    async def settle(self, owner: str, identifier: str, result: Json) -> None:
        """保存已明确接受的结果，禁止用空成功覆盖不存在的收据。"""
        async with self.sessions() as session, session.begin():
            row = await ProjectionDao(session).receipt(owner, identifier)
            if row is None:
                raise RuntimeFailure("runtime_receipt_missing", "运行收据不存在")
            row.state, row.result = "completed", result

    async def fence(self, owner: str) -> Fields | None:
        """读取上次执行代际，不能把连接断开等同于原进程已退出。"""
        async with self.sessions() as session:
            row = await ProjectionDao(session).fence(owner)
            return (
                {"generation": row.generation, "machine": row.machine, "pid": row.pid}
                if row
                else None
            )

    async def claim_execution(self, owner: str, generation: str, machine: str) -> None:
        """进程启动前持久预留栅栏，残留所有者需要显式核实后处理。"""
        async with self.sessions() as session, session.begin():
            dao = ProjectionDao(session)
            if await dao.fence(owner) is not None:
                raise RuntimeFailure(
                    "runtime_recovery_required", "原执行进程尚未确认退出，需要恢复检查", 409
                )
            dao.add(
                RuntimeExecutionFence(owner=owner, generation=generation, machine=machine, pid=None)
            )

    async def attach_execution(self, owner: str, generation: str, pid: int) -> None:
        """记录当前进程身份；代际不符立即拒绝，调用方必须停止子进程。"""
        async with self.sessions() as session, session.begin():
            row = await ProjectionDao(session).fence(owner)
            if row is None or row.generation != generation:
                raise RuntimeFailure("runtime_fence_lost", "运行代际已失效")
            row.pid = pid

    async def release_execution(self, owner: str, generation: str) -> None:
        """仅在监督器确认进程退出后调用，不能清除后继执行者的栅栏。"""
        async with self.sessions() as session, session.begin():
            dao = ProjectionDao(session)
            row = await dao.fence(owner)
            if row is not None and row.generation == generation:
                await dao.delete_fence(row)

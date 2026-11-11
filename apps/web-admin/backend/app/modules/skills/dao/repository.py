"""技能记录 DAO，业务状态判断全部留在 service。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import Database, lock_transaction
from app.modules.skills.entity.bo.evidence import Artifact, Evidence
from app.modules.skills.entity.bo.runs import SkillRun
from app.modules.skills.entity.do.models import (
    ApprovalRow,
    ArtifactRow,
    EvidenceRow,
    OperationReceiptRow,
    RunEventRow,
    SkillRunRow,
)
from app.modules.skills.service.ports import RunTransaction


def run_entity(row: SkillRunRow) -> SkillRun:
    return SkillRun(**{name: getattr(row, name) for name in SkillRun.__dataclass_fields__})


class SqlRunTransaction:
    """稳定 run 锁串行化事件，事件版本不会重复覆盖。"""

    def __init__(self, session: AsyncSession) -> None:
        self.db = session

    async def lock(self, key: str) -> None:
        await lock_transaction(self.db, "web-admin:skill:" + key)

    async def get(self, run_id: str) -> SkillRun | None:
        row = await self.db.get(SkillRunRow, run_id)
        return run_entity(row) if row else None

    async def find(self, owner: str, session: str, request: str) -> SkillRun | None:
        row = await self.db.scalar(
            select(SkillRunRow).where(
                SkillRunRow.owner_id == owner,
                SkillRunRow.session_id == session,
                SkillRunRow.request_id == request,
            )
        )
        return run_entity(row) if row else None

    async def save(self, run: SkillRun, event: str) -> None:
        await self.db.merge(SkillRunRow(**asdict(run)))
        await self.db.flush()
        self.db.add(
            RunEventRow(
                run_id=run.id,
                version=run.version,
                kind=event,
                payload={
                    "runId": run.id,
                    "version": run.version,
                    "event": event,
                    "state": run.state,
                    "revision": run.revision,
                    "stageIndex": run.stage_index,
                },
            )
        )

    async def active(self) -> list[SkillRun]:
        rows = await self.db.scalars(
            select(SkillRunRow).where(
                SkillRunRow.state.in_(["running", "waiting-user", "executing", "needs-revision"])
            )
        )
        return [run_entity(row) for row in rows]

    async def runs(self, owner: str, session: str) -> list[SkillRun]:
        """按会话读取阶段历史，调用方再次检查资源归属。"""
        rows = await self.db.scalars(
            select(SkillRunRow)
            .where(SkillRunRow.owner_id == owner, SkillRunRow.session_id == session)
            .order_by(SkillRunRow.id)
        )
        return [run_entity(row) for row in rows]

    async def artifact(self, artifact_id: str) -> Artifact | None:
        row = await self.db.get(ArtifactRow, artifact_id)
        return (
            Artifact(**{name: getattr(row, name) for name in Artifact.__dataclass_fields__})
            if row
            else None
        )

    async def save_artifact(self, artifact: Artifact) -> None:
        self.db.add(ArtifactRow(**asdict(artifact)))

    async def update_artifact(self, artifact: Artifact) -> None:
        """更新已由用例授权的成果元数据，不改变对象身份。"""
        await self.db.merge(ArtifactRow(**asdict(artifact)))

    async def artifacts(self, owner: str, session: str) -> list[Artifact]:
        """成果目录只返回当前账号会话，路径只在服务端解析。"""
        rows = await self.db.scalars(
            select(ArtifactRow)
            .where(ArtifactRow.owner_id == owner, ArtifactRow.session_id == session)
            .order_by(ArtifactRow.id)
        )
        return [
            Artifact(**{name: getattr(row, name) for name in Artifact.__dataclass_fields__})
            for row in rows
        ]

    async def save_evidence(self, evidence: Evidence) -> None:
        self.db.add(EvidenceRow(**asdict(evidence)))

    async def approval(self, run: SkillRun, state: str) -> None:
        self.db.add(
            ApprovalRow(
                id=str(uuid4()),
                run_id=run.id,
                revision=run.revision,
                plan_hash=run.plan_hash or "",
                state=state,
            )
        )

    async def receipt(self, call_id: str) -> dict[str, object] | None:
        row = await self.db.get(OperationReceiptRow, call_id)
        return (
            {
                "id": row.id,
                "ownerId": row.owner_id,
                "runId": row.run_id,
                "revision": row.revision,
                "state": row.state,
                "result": row.result,
            }
            if row
            else None
        )

    async def save_receipt(
        self, run: SkillRun, call_id: str, state: str, result: dict[str, object] | None
    ) -> None:
        await self.db.merge(
            OperationReceiptRow(
                id=call_id,
                owner_id=run.owner_id,
                run_id=run.id,
                revision=run.revision,
                state=state,
                result=result,
            )
        )


class SqlRunRepository:
    """阶段服务的事务工厂。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[RunTransaction]:
        async with self.database.sessions.begin() as session:
            yield SqlRunTransaction(session)

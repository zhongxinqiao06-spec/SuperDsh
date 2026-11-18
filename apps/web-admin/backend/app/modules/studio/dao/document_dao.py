"""当前结构化工程的读写仓储，不推导创作规则，不提交事务。"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.entity.do.foundation_do import (
    ProjectAsset,
    ProjectEntityVersion,
    ShotReference,
    StoryScene,
    StudioLine,
    StudioScript,
    StudioShot,
)
from app.modules.studio.entity.do.timeline_do import StudioClip, StudioTimeline, StudioTrack

TABLES: dict[
    str,
    type[StoryScene]
    | type[StudioShot]
    | type[StudioLine]
    | type[ShotReference]
    | type[ProjectAsset]
    | type[ProjectEntityVersion]
    | type[StudioClip],
] = {
    "scenes": StoryScene,
    "shots": StudioShot,
    "lines": StudioLine,
    "references": ShotReference,
    "media": ProjectAsset,
    "entities": ProjectEntityVersion,
    "clips": StudioClip,
}


class DocumentDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def read(self, project: str) -> dict[str, Any]:
        result: dict[str, Any] = {
            "script": await self.session.get(StudioScript, project),
            "timeline": await self.session.get(StudioTimeline, project),
        }
        for key, model in TABLES.items():
            query = select(model).where(model.project_id == project)
            if key in {"scenes", "shots", "lines"}:
                query = query.where(model.__table__.c.archived_at.is_(None))
            result[key] = list(await self.session.scalars(query))
        return result

    async def write(
        self,
        project: str,
        script: str,
        rows: dict[str, list[dict[str, Any]]],
        clock: tuple[int, int, int, int],
        mode: str,
        music_gain: float,
    ) -> None:
        """稳定镜头/台词保留身份；移除对象归档，当前引用与片段原子替换。"""
        timeline = await self.session.get(StudioTimeline, project)
        if timeline is None:
            timeline = StudioTimeline(
                project_id=project,
                ticks_per_second=clock[0],
                fps_num=clock[1],
                fps_den=clock[2],
                audio_sample_rate=clock[3],
            )
            self.session.add(timeline)
            await self.session.flush()
            self.session.add_all(
                [
                    StudioTrack(project_id=project, id=kind, kind=kind, position=i)
                    for i, kind in enumerate(("video", "voice", "subtitle", "music", "sound"))
                ]
            )
            await self.session.flush()
        timeline.music_gain = music_gain
        script_row = await self.session.get(StudioScript, project)
        if script_row is None:
            self.session.add(
                StudioScript(project_id=project, source_text=script, adaptation_mode=mode)
            )
        elif script_row.source_text != script or script_row.adaptation_mode != mode:
            script_row.source_text, script_row.revision = script, script_row.revision + 1
            script_row.adaptation_mode = mode
        # 先解除当前引用，再归档对象；历史快照和任务回执不会被删除。
        for key in ("clips", "references", "media", "entities"):
            await self.session.execute(delete(TABLES[key]).where(TABLES[key].project_id == project))
        for key in ("scenes", "shots", "lines"):
            model = TABLES[key]
            ids = [row["id"] for row in rows[key]]
            await self.session.execute(
                update(model)
                .where(model.project_id == project, model.__table__.c.id.not_in(ids))
                .values(archived_at=datetime.now(UTC))
            )
            for row in rows[key]:
                statement = insert(model).values(project_id=project, archived_at=None, **row)
                await self.session.execute(
                    statement.on_conflict_do_update(
                        index_elements=["project_id", "id"], set_={**row, "archived_at": None}
                    )
                )
        await self.session.flush()
        for key in ("media", "entities", "references", "clips"):
            for row in rows[key]:
                self.session.add(TABLES[key](project_id=project, **row))
        await self.session.flush()

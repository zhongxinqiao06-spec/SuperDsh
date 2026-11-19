"""分集加入、移除和先预览后确认的故事拆合；历史工程永不隐式删改或搬迁。"""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.bo.production import ACTIVE
from app.modules.studio.entity.do.models import StudioProject
from app.modules.studio.entity.do.series_do import (
    SeriesCommand,
    SeriesStructurePlan,
    StudioEpisode,
    StudioSeries,
)
from app.modules.studio.entity.vo.series_vo import (
    ConfirmStructurePlan,
    EpisodeInput,
    EpisodeStory,
    ImportEpisode,
    RemoveEpisode,
    StructurePlanInput,
)
from app.modules.studio.entity.vo.studio_vo import identifier
from app.modules.studio.service.foundation_service import authorize
from app.modules.studio.service.series_service import SeriesService, episode_locked

NOTICE = "本次只拆合故事草稿，新集继承当前全剧设定。原镜头、配音、剪辑、任务与素材保留在历史工程，不会自动搬入新集；新集需要重新确认和制作。"


def structure_view(row: SeriesStructurePlan) -> dict:
    """预览向用户明确列出源集、源工程修订和新故事，不包含媒体文件路径。"""
    return {
        "id": row.id,
        "revision": row.revision,
        "planHash": row.plan_hash,
        "state": row.state,
        **row.manifest,
    }


class SeriesStructureService:
    def __init__(self, series: SeriesService) -> None:
        self.series = series

    async def settled(self, session: AsyncSession, project: StudioProject) -> list:
        jobs = await StudioDao(session).jobs(project)
        if any(
            job.state in ACTIVE
            or (job.state in {"unknown", "paused"} and not job.payload.get("replacementPlan"))
            for job in jobs
        ):
            raise DomainError(409, "工程还有进行中或受理待核对的任务，请先处理后再调整分集结构")
        return jobs

    async def source(
        self, session: AsyncSession, account: Account, row: StudioSeries, episode: StudioEpisode
    ) -> dict:
        project = await StudioDao(session).project(account.user_id, episode.project_id, lock=True)
        if project.lifecycle == "archived":
            raise DomainError(409, "单集工程已归档，请先恢复工程再调整结构")
        jobs = await self.settled(session, project)
        export = (await SeriesDao(session).latest_exports([project.id])).get(project.id)
        if export or episode_locked(episode, export):
            raise DomainError(409, "已交付或锁定分集不能移除或拆合；原成片保持可追溯")
        if any(
            proposal.state in {"waiting", "ready"}
            and any(item["episodeId"] == episode.id for item in proposal.original)
            for proposal in await SeriesDao(session).proposals(row.id)
        ):
            raise DomainError(409, "分集还有待处理编排建议，请先采用或放弃")
        document = await self.series.studio.documents.read(session, project.id)
        return {
            "id": episode.id,
            "title": episode.title,
            "number": episode.position,
            "projectId": project.id,
            "projectRevision": project.revision,
            "shots": len(document.shots),
            "mediaCount": len(jobs),
        }

    async def archive(self, session: AsyncSession, episode: StudioEpisode, reason: str) -> None:
        episode.archived, episode.locked = True, True
        episode.archived_at, episode.archive_reason = datetime.now(UTC), reason
        # 历史行仍保留唯一集序；高位历史序号不会与重新编号的活动目录冲突。
        episode.position = await SeriesDao(session).archive_position(episode.series_id)
        await session.flush()

    async def remove(
        self, account: Account, identity: str, episode_id: str, body: RemoveEpisode
    ) -> dict:
        authorize(account, "projects.write")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "episode.remove:" + episode_id
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            episode = await dao.episode(account.user_id, identity, episode_id)
            source = await self.source(session, account, row, episode)
            if source["projectRevision"] != body.projectRevision:
                raise DomainError(409, "工程已更新，请重新确认移除范围")
            episodes = await dao.episodes(account.user_id, identity)
            remaining = [item for item in episodes if item.id != episode_id]
            await self.check_reordered_locks(session, remaining)
            await self.archive(session, episode, "从分集目录移除，原工程只读保留")
            for position, item in enumerate(remaining, 1):
                item.position = position
            return await self.series.finish(session, account, row, body.requestKey, fingerprint)

    async def check_reordered_locks(
        self, session: AsyncSession, episodes: Sequence[StudioEpisode | None]
    ) -> None:
        exports = await SeriesDao(session).latest_exports(
            [episode.project_id for episode in episodes if episode]
        )
        if any(
            episode
            and episode.position != number
            and episode_locked(episode, exports.get(episode.project_id))
            for number, episode in enumerate(episodes, 1)
        ):
            raise DomainError(409, "该调整会改变后续锁定集的集序，请先解锁相关分集或调整范围")

    async def import_episode(self, account: Account, identity: str, body: ImportEpisode) -> dict:
        authorize(account, "projects.write")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "episode.import"
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            project = await StudioDao(session).project(account.user_id, body.projectId, lock=True)
            if project.creation_mode != "storyboard" or project.lifecycle != "active":
                raise DomainError(409, "请选择活动分镜作品；快速视频需先进入分镜创作")
            if project.revision != body.projectRevision:
                raise DomainError(409, "作品已更新，请重新选择要加入的工程版本")
            if await dao.context(account.user_id, project.id):
                raise DomainError(409, "该作品已属于一部剧，包括保留的历史分集，不能重复加入")
            await self.settled(session, project)
            episodes = await dao.episodes(account.user_id, identity)
            if len(episodes) >= 100:
                raise DomainError(422, "每部剧最多编排100集")
            document = await self.series.studio.documents.read(session, project.id)
            dao.add(
                StudioEpisode(
                    id=identifier(),
                    series_id=identity,
                    owner=account.user_id,
                    project_id=project.id,
                    position=len(episodes) + 1,
                    title=body.title or project.title,
                    story=EpisodeStory(
                        synopsis=(project.brief or document.script)[:12000]
                    ).model_dump(),
                    target_duration_ms=project.target_duration_ms
                    or row.target_duration_ms
                    or 45000,
                    settings_revision=1,
                    confirmed_story_revision=1 if document.script or document.shots else None,
                    confirmed_project_revision=project.revision
                    if document.script or document.shots
                    else None,
                )
            )
            return await self.series.finish(session, account, row, body.requestKey, fingerprint)

    async def preview(self, account: Account, identity: str, body: StructurePlanInput) -> dict:
        authorize(account, "projects.write")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "series.structure.preview"
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            episodes = await dao.episodes(account.user_id, identity)
            selected = [ep for ep in episodes if ep.id in body.episodeIds]
            if len(selected) != len(body.episodeIds):
                raise DomainError(422, "所选分集已移除或不属于本剧")
            if selected[-1].position - selected[0].position + 1 != len(selected):
                raise DomainError(422, "合并请选择相邻分集，避免隐式重排其他集")
            if len(episodes) - len(selected) + len(body.episodes) > 100:
                raise DomainError(422, "调整后超出100集限制")
            planned_order = [
                *episodes[: selected[0].position - 1],
                *([None] * len(body.episodes)),
                *episodes[selected[-1].position :],
            ]
            await self.check_reordered_locks(session, planned_order)
            source = [
                await self.source(session, account, row, ep)
                for ep in sorted(selected, key=lambda item: item.project_id)
            ]
            source.sort(key=lambda item: item["number"])
            manifest = {
                "action": body.action,
                "sourceEpisodes": source,
                "episodes": [ep.model_dump() for ep in body.episodes],
                "notice": NOTICE,
            }
            plan = SeriesStructurePlan(
                id=identifier(),
                series_id=identity,
                revision=row.revision,
                manifest=manifest,
                plan_hash=content_hash(manifest),
                state="prepared",
            )
            dao.add(plan)
            result = structure_view(plan)
            dao.add(
                SeriesCommand(
                    id=identifier(),
                    series_id=identity,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    result=result,
                )
            )
            return result

    async def confirm(
        self, account: Account, identity: str, plan_id: str, body: ConfirmStructurePlan
    ) -> dict:
        authorize(account, "projects.write")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "series.structure.confirm:" + plan_id
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            plan = await dao.structure_plan(identity, plan_id)
            if plan.plan_hash != body.planHash or plan.revision != row.revision:
                raise DomainError(409, "分集结构或预览已变化，请重新检查方案")
            if plan.state == "confirmed":
                return plan.result or {}
            episodes = await dao.episodes(account.user_id, identity)
            selected = []
            for frozen in sorted(
                plan.manifest["sourceEpisodes"], key=lambda item: item["projectId"]
            ):
                episode = await dao.episode(account.user_id, identity, frozen["id"])
                if await self.source(session, account, row, episode) != frozen:
                    raise DomainError(409, "源工程或制作任务已变化，请重新预览拆合方案")
                selected.append(episode)
            selected.sort(key=lambda item: item.position)
            before, after = episodes[: selected[0].position - 1], episodes[selected[-1].position :]
            # 媒体任务可以在预览后完成；确认时重新检查未选集的交付锁，避免隐式改集序。
            await self.check_reordered_locks(
                session, [*before, *([None] * len(plan.manifest["episodes"])), *after]
            )
            for episode in selected:
                await self.archive(
                    session,
                    episode,
                    "故事拆集后保留原工程"
                    if plan.manifest["action"] == "split"
                    else "故事合并后保留原工程",
                )
            created = []
            for value in plan.manifest["episodes"]:
                # 临时高位序号避免新行 INSERT 与现有活动目录冲突，事务末统一编号。
                created.append(
                    await self.series.new_episode(
                        session,
                        account,
                        row,
                        EpisodeInput.model_validate(value),
                        await dao.archive_position(identity),
                    )
                )
                await session.flush()
            for number, episode in enumerate([*before, *created, *after], 1):
                episode.position = number
            result = await self.series.finish(session, account, row, body.requestKey, fingerprint)
            plan.state, plan.result = "confirmed", result
            return result

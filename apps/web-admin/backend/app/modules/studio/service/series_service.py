"""整剧规划与单集装配；复用作品文档，不增加媒体队列或 Agent 执行器。"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.dao.work_directory_dao import WorkDirectoryDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.do.models import MediaJob, StudioProject
from app.modules.studio.entity.do.series_do import (
    SeriesCommand,
    SeriesSettingVersion,
    StudioEpisode,
    StudioSeries,
)
from app.modules.studio.entity.vo.foundation_vo import ArchiveProject, ProjectOperation
from app.modules.studio.entity.vo.series_vo import (
    ConfirmEpisode,
    CreateEpisode,
    CreateSeries,
    EpisodeInput,
    LockEpisode,
    ReorderEpisodes,
    UpdateEpisode,
    UpdateSeries,
)
from app.modules.studio.entity.vo.studio_vo import Document, identifier
from app.modules.studio.service.foundation_service import authorize

if TYPE_CHECKING:
    from app.modules.studio.service.studio_service import StudioService


def series_view(row: StudioSeries) -> dict:
    """整剧规格使用与普通作品相同的用户可读字段。"""
    return {
        "id": row.id,
        "title": row.title,
        "revision": row.revision,
        "brief": row.brief,
        "narrativeMode": row.narrative_mode,
        "plannedEpisodes": row.planned_episodes,
        "lifecycle": row.lifecycle,
        "aspectWidth": row.aspect_width,
        "aspectHeight": row.aspect_height,
        "targetDurationMs": row.target_duration_ms,
        "language": row.language,
        "styleBrief": row.style_brief,
        "settingsRevision": row.settings_revision,
        "updated": row.updated.isoformat(),
    }


def episode_locked(row: StudioEpisode, export: MediaJob | None) -> bool:
    """已交付版本默认锁定；用户明确解锁只针对当时的交付回执。"""
    return row.locked or bool(export and export.id != row.unlocked_export_id)


def story_text(story: dict) -> str:
    """确认故事后形成可继续由导演拆解的正文，不自动生成镜头。"""
    labels = {
        "synopsis": "本集故事",
        "opening": "开场",
        "development": "冲突与转折",
        "ending": "结尾",
        "continuity": "前后集承接",
    }
    return "\n\n".join(
        f"{label}\n{story.get(key, '').strip()}"
        for key, label in labels.items()
        if story.get(key, "").strip()
    )


class SeriesService:
    def __init__(self, studio: "StudioService") -> None:
        self.studio = studio

    async def begin(
        self,
        session: AsyncSession,
        account: Account,
        identity: str,
        body: ProjectOperation,
        operation: str,
        *,
        archived: bool = False,
    ) -> tuple[StudioSeries, dict | None, str]:
        """整剧行锁串行化编排写入，先复用回执再核对修订，断网重试不多写。"""
        dao = SeriesDao(session)
        row = await dao.series(account.user_id, identity, lock=True)
        fingerprint = content_hash({"operation": operation, **body.model_dump()})
        prior = await dao.command(identity, body.requestKey)
        if prior:
            if prior.request_hash != fingerprint:
                raise DomainError(409, "操作号已用于其他整剧修改")
            return row, prior.result, fingerprint
        if row.revision != body.revision:
            raise DomainError(409, "整剧已在其他页面更新，请载入新版本后合并")
        if row.lifecycle == "archived" and not archived:
            raise DomainError(409, "请先恢复整剧，再继续编排")
        return row, None, fingerprint

    async def finish(
        self, session: AsyncSession, account: Account, row: StudioSeries, key: str, fingerprint: str
    ) -> dict:
        row.revision += 1
        row.updated = datetime.now(UTC)
        await session.flush()
        result = await self.detail(session, account, row)
        SeriesDao(session).add(
            SeriesCommand(
                id=identifier(),
                series_id=row.id,
                operation_key=key,
                request_hash=fingerprint,
                result=result,
            )
        )
        return result

    async def detail(self, session: AsyncSession, account: Account, row: StudioSeries) -> dict:
        dao = SeriesDao(session)
        episodes = await dao.episodes(account.user_id, row.id)
        exports = await dao.latest_exports([item.project_id for item in episodes])
        # 目录只取当前工程摘要；查询仍由 DAO 负责，归档子工程可追溯。
        summaries = await WorkDirectoryDao(session).summaries(
            account.user_id, [episode.project_id for episode in episodes]
        )
        items = []
        for episode in episodes:
            summary = summaries[episode.project_id]
            export = exports.get(episode.project_id)
            confirmed = episode.confirmed_story_revision == episode.story_revision
            stage = (
                "delivery"
                if export and export.revision == summary["revision"]
                else "script"
                if not confirmed
                else "storyboard"
                if not summary["shots"]
                else "production"
                if summary["adopted"] < summary["shots"]
                else "timeline"
            )
            items.append(
                {
                    "id": episode.id,
                    "number": episode.position,
                    "title": episode.title,
                    "projectId": episode.project_id,
                    "projectRevision": summary["revision"],
                    "story": episode.story,
                    "storyRevision": episode.story_revision,
                    "confirmedStoryRevision": episode.confirmed_story_revision,
                    "targetDurationMs": episode.target_duration_ms,
                    "settingsRevision": episode.settings_revision,
                    "locked": episode_locked(episode, export),
                    "stage": stage,
                    "shots": summary["shots"],
                    "adopted": summary["adopted"],
                    "coverJobId": summary["coverJobId"],
                    "coverAssetId": summary["coverAssetId"],
                    "deliverable": {
                        "jobId": export.id,
                        "revision": export.revision,
                        "updated": export.updated.isoformat(),
                    }
                    if export
                    else None,
                }
            )
        setting = await dao.settings(row.id, row.settings_revision)
        assets = []
        for identity in setting.asset_version_ids:
            asset = await StudioDao(session).owned_asset(account.user_id, identity)
            assets.append(
                {
                    **asset.definition,
                    "id": asset.id,
                    "family": asset.family,
                    "project": asset.project,
                    "parent": asset.parent,
                }
            )
        current = next((item for item in items if item["stage"] != "delivery"), None)
        return {
            **series_view(row),
            "episodes": items,
            "settings": assets,
            "episodeCount": len(items),
            "deliveredCount": sum(bool(item["deliverable"]) for item in items),
            "currentEpisodeId": current["id"] if current else None,
            "archivedEpisodes": [
                {
                    "id": episode.id,
                    "title": episode.title,
                    "projectId": episode.project_id,
                    "archivedAt": episode.archived_at.isoformat() if episode.archived_at else None,
                    "reason": episode.archive_reason,
                }
                for episode in await dao.episodes(account.user_id, row.id, archived=True)
            ],
        }

    async def get(self, account: Account, identity: str) -> dict:
        authorize(account, "projects.read")
        async with self.studio.database.sessions() as session:
            return await self.detail(
                session, account, await SeriesDao(session).series(account.user_id, identity)
            )

    async def create(self, account: Account, body: CreateSeries) -> dict:
        authorize(account, "projects.write")
        fingerprint = content_hash(body.model_dump(exclude={"requestKey"}))
        async with self.studio.database.sessions.begin() as session:
            dao = SeriesDao(session)
            previous = await dao.creation(account.user_id, body.requestKey)
            if previous:
                if previous.creation_hash != fingerprint:
                    raise DomainError(409, "同一创建请求已使用不同整剧内容")
                return await self.detail(session, account, previous)
            row = StudioSeries(
                id=identifier(),
                owner=account.user_id,
                title=body.title,
                creation_key=body.requestKey,
                creation_hash=fingerprint,
                updated=datetime.now(UTC),
            )
            self.apply_brief(row, body)
            dao.add(row)
            await session.flush()
            dao.add(SeriesSettingVersion(series_id=row.id, revision=1, asset_version_ids=[]))
            await session.flush()
            if body.createEpisodeDrafts:
                for number in range(1, body.plannedEpisodes + 1):
                    await self.new_episode(
                        session,
                        account,
                        row,
                        EpisodeInput(
                            title=f"第{number}集", targetDurationMs=body.targetDurationMs or 45000
                        ),
                        number,
                    )
                await session.flush()
            return await self.detail(session, account, row)

    @staticmethod
    def apply_brief(row: StudioSeries, body: CreateSeries | UpdateSeries) -> None:
        row.title, row.brief, row.style_brief = body.title, body.brief, body.styleBrief
        row.narrative_mode, row.planned_episodes = body.narrativeMode, body.plannedEpisodes
        row.aspect_width, row.aspect_height = body.aspectWidth, body.aspectHeight
        row.target_duration_ms, row.language = body.targetDurationMs, body.language

    async def update(
        self, account: Account, identity: str, body: UpdateSeries | ArchiveProject
    ) -> dict:
        authorize(account, "projects.write")
        async with self.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.begin(
                session,
                account,
                identity,
                body,
                "series.update",
                archived=isinstance(body, ArchiveProject),
            )
            if previous:
                return previous
            if isinstance(body, ArchiveProject):
                # 与单集写入共用项目锁；正在提交的编辑先完成，随后归档阻止新写入。
                for episode in sorted(
                    await SeriesDao(session).episodes(account.user_id, identity),
                    key=lambda item: item.project_id,
                ):
                    await StudioDao(session).project(account.user_id, episode.project_id, lock=True)
                row.lifecycle = "archived" if body.archived else "active"
            else:
                self.apply_brief(row, body)
            return await self.finish(session, account, row, body.requestKey, fingerprint)

    async def create_episode(self, account: Account, identity: str, body: CreateEpisode) -> dict:
        authorize(account, "projects.write")
        async with self.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.begin(
                session, account, identity, body, "episode.create"
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            episodes = await dao.episodes(account.user_id, identity)
            if len(episodes) >= 100:
                raise DomainError(422, "每部剧最多编排100集")
            await self.new_episode(session, account, row, body, len(episodes) + 1)
            return await self.finish(session, account, row, body.requestKey, fingerprint)

    async def new_episode(
        self,
        session: AsyncSession,
        account: Account,
        row: StudioSeries,
        body: EpisodeInput,
        position: int,
    ) -> StudioEpisode:
        """内部装配共用创建事务；分集草稿没有媒体任务，不调用 AI。"""
        project = StudioProject(
            id=identifier(),
            owner=account.user_id,
            title=body.title,
            revision=0,
            brief=body.story.synopsis,
            style_brief=row.style_brief,
            aspect_width=row.aspect_width,
            aspect_height=row.aspect_height,
            target_duration_ms=body.targetDurationMs,
            language=row.language,
        )
        FoundationDao(session).add_project(project)
        await session.flush()
        dao = SeriesDao(session)
        setting = await dao.settings(row.id, row.settings_revision)
        await self.studio.documents.persist(
            session, account, project, Document(assets=setting.asset_version_ids), "创建分集工程"
        )
        episode = StudioEpisode(
            id=identifier(),
            series_id=row.id,
            owner=account.user_id,
            project_id=project.id,
            position=position,
            title=body.title,
            story=body.story.model_dump(),
            target_duration_ms=body.targetDurationMs,
            settings_revision=row.settings_revision,
        )
        dao.add(episode)
        return episode

    async def mutate_episode(
        self,
        account: Account,
        identity: str,
        episode_id: str,
        body: UpdateEpisode | ConfirmEpisode | LockEpisode,
    ) -> dict:
        authorize(account, "projects.write")
        async with self.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.begin(
                session, account, identity, body, type(body).__name__ + ":" + episode_id
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            episode = await dao.episode(account.user_id, identity, episode_id)
            export = (await dao.latest_exports([episode.project_id])).get(episode.project_id)
            if isinstance(body, LockEpisode):
                await StudioDao(session).project(account.user_id, episode.project_id, lock=True)
                episode.locked = body.locked
                episode.unlocked_export_id = export.id if export and not body.locked else None
            else:
                if episode_locked(episode, export):
                    raise DomainError(409, "本集已锁定，请先明确解锁后修改；原交付版本仍保留")
                if isinstance(body, UpdateEpisode):
                    if (episode.title, episode.story, episode.target_duration_ms) != (
                        body.title,
                        body.story.model_dump(),
                        body.targetDurationMs,
                    ):
                        episode.title, episode.story = body.title, body.story.model_dump()
                        episode.target_duration_ms = body.targetDurationMs
                        episode.story_revision += 1
                else:
                    await self.confirm(session, account, episode, body)
            return await self.finish(session, account, row, body.requestKey, fingerprint)

    async def confirm(
        self, session: AsyncSession, account: Account, episode: StudioEpisode, body: ConfirmEpisode
    ) -> None:
        if not episode.story.get("synopsis", "").strip():
            raise DomainError(422, "请先补充本集故事，再确认进入制作")
        if any(
            proposal.state in {"waiting", "ready"}
            and any(item["episodeId"] == episode.id for item in proposal.original)
            for proposal in await SeriesDao(session).proposals(episode.series_id)
        ):
            raise DomainError(409, "本集还有待处理的编排建议，请先采用或放弃")
        project = await StudioDao(session).project(account.user_id, episode.project_id, lock=True)
        if project.revision != body.projectRevision or project.lifecycle == "archived":
            raise DomainError(409, "单集工程已更新或归档，请重新检查")
        document = await self.studio.documents.read(session, project.id)
        script = story_text(episode.story)
        if (
            document.script
            and document.script != script
            and content_hash(document.script) != episode.confirmed_script_hash
        ):
            raise DomainError(409, "单集正文已有手工修改，请先在单集剧本页核对；本次未覆盖正文")
        if document.script != script and any(scene.scriptRange for scene in document.scenes):
            raise DomainError(
                409, "单集场次已关联原稿，请先在剧本页对比修改并调整关联；本次未覆盖正文和场次"
            )
        project.title, project.brief, project.target_duration_ms = (
            episode.title,
            episode.story["synopsis"],
            episode.target_duration_ms,
        )
        document.script = script
        # 重新确认只同步正文，不触碰已有镜头、配音、字幕和采用结果。
        document = await self.studio.documents.persist(
            session, account, project, document, "确认分集故事"
        )
        episode.confirmed_story_revision = episode.story_revision
        episode.confirmed_project_revision = project.revision
        episode.confirmed_script_hash = content_hash(document.script)

    async def reorder(self, account: Account, identity: str, body: ReorderEpisodes) -> dict:
        authorize(account, "projects.write")
        async with self.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.begin(
                session, account, identity, body, "episode.reorder"
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            episodes = await dao.episodes(account.user_id, identity)
            if len(body.episodeIds) != len(episodes) or set(body.episodeIds) != {
                episode.id for episode in episodes
            }:
                raise DomainError(422, "排序须包含每一集且不能重复")
            exports = await dao.latest_exports([episode.project_id for episode in episodes])
            positions = {identity: position for position, identity in enumerate(body.episodeIds, 1)}
            for episode in episodes:
                if (
                    episode_locked(episode, exports.get(episode.project_id))
                    and positions[episode.id] != episode.position
                ):
                    raise DomainError(409, "已锁定集不能移动，请先解锁并检查前后集承接")
                episode.position = positions[episode.id]
            return await self.finish(session, account, row, body.requestKey, fingerprint)

    async def context(self, account: Account, project_id: str) -> dict | None:
        authorize(account, "projects.read")
        async with self.studio.database.sessions() as session:
            await StudioDao(session).project(account.user_id, project_id)
            episode = await SeriesDao(session).context(account.user_id, project_id)
            if episode is None:
                return None
            detail = await self.detail(
                session,
                account,
                await SeriesDao(session).series(account.user_id, episode.series_id),
            )
            return {
                "seriesId": detail["id"],
                "seriesTitle": detail["title"],
                "seriesRevision": detail["revision"],
                "seriesLifecycle": detail["lifecycle"],
                "episodeId": episode.id,
                "episodeTitle": episode.title,
                "number": episode.position,
                "settingsRevision": episode.settings_revision,
                "currentSettingsRevision": detail["settingsRevision"],
                "episodes": detail["episodes"],
                "archived": episode.archived,
                "locked": detail["lifecycle"] == "archived"
                or episode.archived
                or next(
                    (item["locked"] for item in detail["episodes"] if item["id"] == episode.id),
                    True,
                ),
            }

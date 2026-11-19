"""全剧设定与逐集采用；仅替换仍沿用旧基线的引用，保留本集手工造型。"""

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import stable_id
from app.modules.studio.entity.bo.library_changes import replace_reference
from app.modules.studio.entity.do.series_do import SeriesSettingVersion
from app.modules.studio.entity.vo.series_vo import ApplySeriesSettings, SeriesSettings
from app.modules.studio.service.foundation_service import authorize
from app.modules.studio.service.series_service import SeriesService, episode_locked


class SeriesSettingsService:
    def __init__(self, series: SeriesService) -> None:
        self.series = series

    async def update(self, account: Account, identity: str, body: SeriesSettings) -> dict:
        authorize(account, "projects.write")
        authorize(account, "assets.read")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "series.settings"
            )
            if previous:
                return previous
            if len(set(body.assetVersionIds)) != len(body.assetVersionIds):
                raise DomainError(422, "设定版本不能重复")
            families = set()
            for asset_id in body.assetVersionIds:
                asset = await StudioDao(session).owned_asset(account.user_id, asset_id)
                if asset.project is not None:
                    raise DomainError(422, "请先把本片设定收藏到个人库，再作为全剧设定")
                if asset.family in families:
                    raise DomainError(422, "同一设定请选择一个版本；本集换装可在单集内调整")
                families.add(asset.family)
            row.settings_revision += 1
            SeriesDao(session).add(
                SeriesSettingVersion(
                    series_id=identity,
                    revision=row.settings_revision,
                    asset_version_ids=body.assetVersionIds,
                )
            )
            return await self.series.finish(session, account, row, body.requestKey, fingerprint)

    async def apply(self, account: Account, identity: str, body: ApplySeriesSettings) -> dict:
        authorize(account, "projects.write")
        authorize(account, "assets.read")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "series.settings.apply"
            )
            if previous:
                return previous
            dao, projects = SeriesDao(session), StudioDao(session)
            episodes = await dao.episodes(account.user_id, identity)
            selected = set(body.episodeIds)
            if len(selected) != len(body.episodeIds) or selected - {ep.id for ep in episodes}:
                raise DomainError(422, "请选择本剧中的分集且不能重复")
            exports = await dao.latest_exports([ep.project_id for ep in episodes])
            current = await dao.settings(identity, row.settings_revision)
            incoming = {
                asset.family: asset
                for asset in [
                    await projects.owned_asset(account.user_id, key)
                    for key in current.asset_version_ids
                ]
            }
            for episode in sorted(episodes, key=lambda item: item.project_id):
                if episode.id not in selected:
                    continue
                if episode_locked(episode, exports.get(episode.project_id)):
                    raise DomainError(409, "所选分集中有已锁定集，请移出范围或先解锁")
                project = await projects.project(account.user_id, episode.project_id, lock=True)
                if (
                    body.projectRevisions.get(episode.project_id) != project.revision
                    or project.lifecycle == "archived"
                ):
                    raise DomainError(409, "单集工程已更新或归档，请重新检查更新范围")
                document = await self.series.studio.documents.read(session, project.id)
                baseline = await dao.settings(identity, episode.settings_revision)
                for key in baseline.asset_version_ids:
                    source = await projects.owned_asset(account.user_id, key)
                    replacement = incoming.get(source.family)
                    if not replacement or replacement.id == source.id:
                        continue
                    old = (
                        stable_id(project.id, source.id)
                        if source.definition["kind"] in {"character", "scene", "prop"}
                        else source.id
                    )
                    # 本片已有手工派生版本时不会命中旧基线，因此不会被整剧更新覆盖。
                    if old in document.assets:
                        new = await self.series.studio.asset_versions.project_version(
                            session, account, project.id, replacement
                        )
                        document = replace_reference(document, old, new)
                for asset in incoming.values():
                    new = await self.series.studio.asset_versions.project_version(
                        session, account, project.id, asset
                    )
                    if new not in document.assets:
                        document.assets.append(new)
                await self.series.studio.documents.persist(
                    session, account, project, document, "明确采用全剧设定版本"
                )
                episode.settings_revision = row.settings_revision
            return await self.series.finish(session, account, row, body.requestKey, fingerprint)

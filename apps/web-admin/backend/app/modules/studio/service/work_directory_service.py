"""作品分类只聚合可访问摘要，分集留在整剧中而不重复铺满顶层目录。"""

from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.dao.work_directory_dao import WorkDirectoryDao
from app.modules.studio.service.foundation_service import authorize
from app.modules.studio.service.series_service import SeriesService


class WorkDirectoryService:
    def __init__(self, series: SeriesService) -> None:
        self.series = series

    async def page(
        self, account: Account, mode: str, lifecycle: str, search: str, page: int, size: int
    ) -> dict:
        authorize(account, "projects.read")
        async with self.series.studio.database.sessions() as session:
            dao = WorkDirectoryDao(session)
            rows, total = await dao.page(account.user_id, mode, lifecycle, search, page, size)
            projects = await dao.summaries(
                account.user_id, [row["id"] for row in rows if row["kind"] != "series"]
            )
            items = []
            for row in rows:
                extra = {
                    "episodeCount": 0,
                    "deliveredCount": 0,
                    "currentEpisodeId": None,
                    "currentEpisodeNumber": None,
                    "currentStage": None,
                }
                if row["kind"] != "series":
                    items.append(
                        {**projects[row["id"]], **row, **extra, "coverProjectId": row["id"]}
                    )
                    continue
                series = await SeriesDao(session).series(account.user_id, row["id"])
                detail = await self.series.detail(session, account, series)
                episodes = detail["episodes"]
                current = next(
                    (
                        episode
                        for episode in episodes
                        if episode["id"] == detail["currentEpisodeId"]
                    ),
                    None,
                )
                cover = next(
                    (
                        episode
                        for episode in episodes
                        if episode["coverJobId"] or episode["coverAssetId"]
                    ),
                    None,
                )
                items.append(
                    {
                        **row,
                        "aspectWidth": series.aspect_width,
                        "aspectHeight": series.aspect_height,
                        "targetDurationMs": series.target_duration_ms,
                        "plannedEpisodes": series.planned_episodes,
                        "shots": sum(ep["shots"] for ep in episodes),
                        "adopted": sum(ep["adopted"] for ep in episodes),
                        "coverProjectId": cover["projectId"] if cover else None,
                        "coverJobId": cover["coverJobId"] if cover else None,
                        "coverAssetId": cover["coverAssetId"] if cover else None,
                        "episodeCount": detail["episodeCount"],
                        "deliveredCount": detail["deliveredCount"],
                        # 自动建立的空白分集尚无创作进度，作品库应从分集编排打开。
                        "hasEpisodeProgress": any(
                            ep["storyRevision"] > 1
                            or ep["stage"] != "script"
                            or ep["shots"]
                            or any(ep["story"].values())
                            for ep in episodes
                        ),
                        "currentEpisodeId": current["id"] if current else None,
                        "currentEpisodeNumber": current["number"] if current else None,
                        "currentStage": current["stage"] if current else None,
                    }
                )
            return {"items": items, "total": total}

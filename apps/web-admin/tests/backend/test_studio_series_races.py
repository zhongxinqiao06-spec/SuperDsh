"""编排异步回写等待整剧锁时，用户放弃必须胜过迟到的模型建议。"""

import asyncio

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.entity.do.series_do import StudioSeries
from app.modules.studio.entity.vo.series_vo import SuggestSeriesProposal
from app.modules.studio.service.series_proposal_service import SeriesProposalService
from app.modules.studio.service.series_service import SeriesService


async def test_discard_survives_suggestion_already_loaded_before_lock(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    series = (
        await client.post(
            "/api/studio/series",
            json={
                "title": "迟到结果测试",
                "requestKey": "race-series",
                "plannedEpisodes": 1,
                "createEpisodeDrafts": True,
            },
        )
    ).json()
    episode = series["episodes"][0]
    url = f"/api/studio/series/{series['id']}/proposals"
    pending = (
        await client.post(
            url,
            json={
                "revision": series["revision"],
                "requestKey": "race-proposal",
                "episodeIds": [episode["id"]],
                "instruction": "给出开场建议",
            },
        )
    ).json()
    loaded, proceed = asyncio.Event(), asyncio.Event()
    original = SeriesDao.series

    async def gated(
        dao: SeriesDao, owner: str, identity: str, *, lock: bool = False
    ) -> StudioSeries:
        task = asyncio.current_task()
        if lock and task and task.get_name() == "late-series-suggestion":
            loaded.set()
            await asyncio.wait_for(proceed.wait(), timeout=10)
        return await original(dao, owner, identity, lock=lock)

    monkeypatch.setattr(SeriesDao, "series", gated)
    service = SeriesProposalService(SeriesService(app.state.services.studio))
    task = asyncio.create_task(
        service.suggest(
            account,
            episode["projectId"],
            SuggestSeriesProposal.model_validate(
                {
                    "proposalId": pending["id"],
                    "episodes": [{"episodeId": episode["id"], "story": {"opening": "迟到开场"}}],
                }
            ),
        ),
        name="late-series-suggestion",
    )
    try:
        await asyncio.wait_for(loaded.wait(), timeout=10)
        discarded = await client.post(
            f"{url}/{pending['id']}/resolve",
            json={
                "revision": pending["revision"],
                "requestKey": "discard-while-pending",
                "action": "discard",
            },
        )
        assert discarded.status_code == 200, discarded.text
        proceed.set()
        with pytest.raises(DomainError, match="迟到建议未写入"):
            await task
        latest = (await client.get(url)).json()[0]
        assert latest["state"] == "discarded" and latest["suggestions"] == []
    finally:
        proceed.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

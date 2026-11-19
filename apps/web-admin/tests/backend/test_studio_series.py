"""三类目录与短剧真实 API/数据库回归；合成作品随独立 fixture 数据库清理。"""

import asyncio
from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.do.models import MediaJob
from app.modules.studio.entity.vo.series_vo import SuggestSeriesProposal
from app.modules.studio.service.series_proposal_service import SeriesProposalService
from app.modules.studio.service.series_service import SeriesService

ROOT = "/api/studio"


async def test_series_scaffolds_six_drafts_without_generation(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    body = {
        "title": "六集草稿",
        "plannedEpisodes": 6,
        "createEpisodeDrafts": True,
        "requestKey": "six-drafts",
        "targetDurationMs": 60000,
    }
    created = await client.post(ROOT + "/series", json=body)
    assert created.status_code == 200, created.text
    series = created.json()
    assert len(series["episodes"]) == 6
    assert len({ep["projectId"] for ep in series["episodes"]}) == 6
    assert all(
        ep["stage"] == "script" and ep["targetDurationMs"] == 60000 and not ep["story"]["synopsis"]
        for ep in series["episodes"]
    )
    assert (await client.post(ROOT + "/series", json=body)).json() == series
    pending = await client.post(
        f"{ROOT}/series/{series['id']}/proposals",
        json={
            "revision": series["revision"],
            "requestKey": "six-outline",
            "episodeIds": [ep["id"] for ep in series["episodes"]],
            "instruction": "按六集安排月球旅行",
        },
    )
    assert pending.status_code == 200, pending.text
    assert len(pending.json()["base"]) == 6
    assert (await client.get(ROOT + "/jobs")).json()["total"] == 0


async def create_series(client: AsyncClient) -> dict:
    response = await client.post(
        ROOT + "/series",
        json={
            "title": "隔离太空小狗",
            "requestKey": "create-series",
            "aspectWidth": 9,
            "aspectHeight": 16,
            "plannedEpisodes": 6,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_initial_three_episodes_can_expand_without_rewriting_projects(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    """初始集数只创建草稿；扩集、重排和缩小规划不覆盖既有单集工程。"""
    app, client = platform
    await bootstrap(client)
    created = await client.post(
        ROOT + "/series",
        json={
            "title": "隔离扩集验证",
            "narrativeMode": "anthology",
            "plannedEpisodes": 3,
            "targetDurationMs": 90000,
            "createEpisodeDrafts": True,
            "requestKey": "initial-three",
        },
    )
    assert created.status_code == 200, created.text
    series = created.json()
    original_ids = [ep["id"] for ep in series["episodes"]]
    first = series["episodes"][0]
    project_path = f"{ROOT}/projects/{first['projectId']}"
    project = (await client.get(project_path)).json()
    document = {
        **project["document"],
        "script": "用户已手工编辑的原稿必须保留",
        "shots": [{"id": "stable-shot", "action": "保留手工镜头", "duration": 5000}],
    }
    saved = await client.put(
        project_path,
        json={"revision": project["revision"], "document": document, "requestKey": "edit-shot"},
    )
    assert saved.status_code == 200, saved.text
    series = (await client.get(f"{ROOT}/series/{series['id']}")).json()
    # 合成交付回执验证扩集不改变已交付工程；不冒充真实媒体渲染覆盖。
    async with app.state.services.studio.database.sessions.begin() as session:
        for index, episode in enumerate(series["episodes"]):
            session.add(
                MediaJob(
                    id=f"expand-export-{index}",
                    project=episode["projectId"],
                    request_key=f"expand-export-{index}",
                    subject="timeline",
                    kind="export",
                    revision=episode["projectRevision"],
                    state="ready",
                    payload={"duration": 1000},
                )
            )
    series = (await client.get(f"{ROOT}/series/{series['id']}")).json()
    originals = {ep["id"]: ep for ep in series["episodes"]}
    snapshots = {
        ep["projectId"]: (await client.get(f"{ROOT}/projects/{ep['projectId']}")).json()
        for ep in series["episodes"]
    }
    addition = {
        "title": "新增第四集",
        "story": {"synopsis": "后续主题", "ending": "独立成篇"},
        "targetDurationMs": 120000,
        "revision": series["revision"],
        "requestKey": "add-fourth-once",
    }
    episode_path = f"{ROOT}/series/{series['id']}/episodes"
    added = await client.post(episode_path, json=addition)
    assert added.status_code == 200, added.text
    series = added.json()
    assert len(series["episodes"]) == 4 and series["plannedEpisodes"] == 3
    assert (await client.post(episode_path, json=addition)).json() == series
    fourth = series["episodes"][-1]
    assert fourth["targetDurationMs"] == 120000 and fourth["projectId"] not in snapshots
    reordered = await client.put(
        f"{ROOT}/series/{series['id']}/order",
        json={
            "revision": series["revision"],
            "requestKey": "move-fourth-first",
            "episodeIds": [fourth["id"], *original_ids],
        },
    )
    assert reordered.status_code == 409
    # 成片锁阻止改序；用户明确解锁后才重排，既有交付仍绑定原工程修订。
    for original_id in original_ids:
        unlocked = await client.post(
            f"{ROOT}/series/{series['id']}/episodes/{original_id}/lock",
            json={
                "revision": series["revision"],
                "requestKey": "unlock-" + original_id,
                "locked": False,
            },
        )
        assert unlocked.status_code == 200, unlocked.text
        series = unlocked.json()
    reordered = await client.put(
        f"{ROOT}/series/{series['id']}/order",
        json={
            "revision": series["revision"],
            "requestKey": "reorder-after-unlock",
            "episodeIds": [fourth["id"], *original_ids],
        },
    )
    assert reordered.status_code == 200, reordered.text
    series = reordered.json()
    changed_plan = await client.patch(
        f"{ROOT}/series/{series['id']}",
        json={
            "title": series["title"],
            "narrativeMode": "anthology",
            "plannedEpisodes": 2,
            "revision": series["revision"],
            "requestKey": "planning-is-not-delete",
        },
    )
    assert changed_plan.status_code == 200, changed_plan.text
    current = changed_plan.json()
    assert [ep["id"] for ep in current["episodes"]] == [fourth["id"], *original_ids]
    for ep in current["episodes"][1:]:
        before = originals[ep["id"]]
        for key in (
            "projectId",
            "projectRevision",
            "title",
            "story",
            "targetDurationMs",
            "deliverable",
        ):
            assert ep[key] == before[key]
        after = (await client.get(f"{ROOT}/projects/{ep['projectId']}")).json()
        for key in ("document", "revision", "history", "jobs"):
            assert after[key] == snapshots[ep["projectId"]][key]
    assert (await client.get(ROOT + "/jobs")).json()["total"] == 3


async def add_episode(client: AsyncClient, series: dict, name: str) -> dict:
    response = await client.post(
        f"{ROOT}/series/{series['id']}/episodes",
        json={
            "title": name,
            "revision": series["revision"],
            "requestKey": "add-" + str(series["revision"]),
            "story": {
                "synopsis": "小狗找到了星图",
                "opening": "登上月球",
                "development": "地图突然发光",
                "ending": "新的信号出现",
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_series_directory_identity_revision_and_lock(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    first, retry = await asyncio.gather(create_series(client), create_series(client))
    assert first["id"] == retry["id"] and first["revision"] == 1
    assert first["episodes"] == []
    series = await add_episode(client, first, "第一集")
    series = await add_episode(client, series, "第二集")
    one, two = series["episodes"]
    assert one["projectId"] != two["projectId"]
    body = {
        "revision": series["revision"],
        "requestKey": "reorder",
        "episodeIds": [two["id"], one["id"]],
    }
    response = await client.put(f"{ROOT}/series/{series['id']}/order", json=body)
    assert response.status_code == 200, response.text
    series = response.json()
    assert [(ep["id"], ep["number"]) for ep in series["episodes"]] == [
        (two["id"], 1),
        (one["id"], 2),
    ]
    assert (await client.put(f"{ROOT}/series/{series['id']}/order", json=body)).json() == series
    body["requestKey"] = "stale"
    assert (await client.put(f"{ROOT}/series/{series['id']}/order", json=body)).status_code == 409
    standalone = await client.post(ROOT + "/projects", json={"title": "独立分镜"})
    assert standalone.status_code == 200
    works = (await client.get(ROOT + "/works")).json()
    assert works["total"] == 2 and {item["kind"] for item in works["items"]} == {
        "series",
        "storyboard",
    }
    assert (await client.get(ROOT + "/works", params={"mode": "series"})).json()["total"] == 1
    assert (await client.get(ROOT + "/works", params={"mode": "quick"})).json()["total"] == 0
    context = (await client.get(f"{ROOT}/projects/{one['projectId']}/episode-context")).json()
    assert context["seriesId"] == series["id"] and context["number"] == 2
    episode_path = f"{ROOT}/series/{series['id']}/episodes/{one['id']}"
    locked = await client.post(
        episode_path + "/lock",
        json={"revision": series["revision"], "requestKey": "lock", "locked": True},
    )
    assert locked.status_code == 200, locked.text
    series = locked.json()
    project = (await client.get(f"{ROOT}/projects/{one['projectId']}")).json()
    denied = await client.put(
        f"{ROOT}/projects/{one['projectId']}",
        json={
            "revision": project["revision"],
            "document": project["document"],
            "requestKey": "locked-save",
        },
    )
    assert denied.status_code == 409 and "锁定" in denied.text
    denied = await client.post(
        f"{ROOT}/projects/{one['projectId']}/generation-plans",
        json={"revision": project["revision"], "requestKey": "locked-generate", "mode": "all"},
    )
    assert denied.status_code == 409 and "锁定" in denied.text
    unlocked = await client.post(
        episode_path + "/lock",
        json={"revision": series["revision"], "requestKey": "unlock", "locked": False},
    )
    assert unlocked.status_code == 200
    series = unlocked.json()
    confirm = await client.post(
        episode_path + "/confirm",
        json={
            "revision": series["revision"],
            "projectRevision": one["projectRevision"],
            "requestKey": "confirm",
        },
    )
    assert confirm.status_code == 200, confirm.text
    series = confirm.json()
    project = (await client.get(f"{ROOT}/projects/{one['projectId']}")).json()
    assert "地图突然发光" in project["document"]["script"]
    assert project["document"]["shots"] == []
    # 合成完成回执只验证交付锁与历史版本，不冒充真实媒体生成或渲染。
    async with app.state.services.studio.database.sessions.begin() as session:
        session.add(
            MediaJob(
                id="synthetic-export",
                project=one["projectId"],
                request_key="export-lock",
                subject="export",
                kind="export",
                revision=project["revision"],
                state="ready",
                payload={"duration": 1000},
            )
        )
    delivered = (await client.get(f"{ROOT}/series/{series['id']}")).json()
    delivered_episode = next(ep for ep in delivered["episodes"] if ep["id"] == one["id"])
    assert delivered_episode["locked"] and delivered_episode["stage"] == "delivery"
    denied = await client.put(
        f"{ROOT}/projects/{one['projectId']}",
        json={"revision": project["revision"], "document": project["document"]},
    )
    assert denied.status_code == 409
    unlocked = await client.post(
        episode_path + "/lock",
        json={"revision": delivered["revision"], "requestKey": "unlock-delivered", "locked": False},
    )
    assert unlocked.status_code == 200, unlocked.text
    series = unlocked.json()
    saved = await client.put(
        f"{ROOT}/projects/{one['projectId']}",
        json={"revision": project["revision"], "document": project["document"]},
    )
    assert saved.status_code == 200, saved.text
    project = (await client.get(f"{ROOT}/projects/{one['projectId']}")).json()
    current = (await client.get(f"{ROOT}/series/{series['id']}")).json()
    delivered_episode = next(ep for ep in current["episodes"] if ep["id"] == one["id"])
    assert delivered_episode["deliverable"]["revision"] < delivered_episode["projectRevision"]
    assert delivered_episode["stage"] != "delivery"
    archived = await client.post(
        f"{ROOT}/series/{series['id']}/archive",
        json={"revision": series["revision"], "requestKey": "archive", "archived": True},
    )
    assert archived.status_code == 200, archived.text
    assert (await client.get(ROOT + "/works", params={"mode": "series"})).json()["total"] == 0
    assert (
        await client.get(ROOT + "/works", params={"mode": "series", "lifecycle": "archived"})
    ).json()["total"] == 1
    denied = await client.put(
        f"{ROOT}/projects/{one['projectId']}",
        json={
            "revision": project["revision"],
            "document": project["document"],
            "requestKey": "archived-save",
        },
    )
    assert denied.status_code == 409 and "整剧已归档" in denied.text
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    service = SeriesService(app.state.services.studio)
    with pytest.raises(DomainError, match="整剧不存在"):
        await service.get(replace(account, user_id="other-owner"), series["id"])
    with pytest.raises(DomainError, match="products.entertainment"):
        await service.get(replace(account, permissions=("studio.projects.read",)), series["id"])


async def test_series_ai_scope_review_and_manual_conflict(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    series = await add_episode(client, await create_series(client), "第一集")
    series = await add_episode(client, series, "第二集")
    episode, other = series["episodes"]
    base = episode["story"]
    proposal = await client.post(
        f"{ROOT}/series/{series['id']}/proposals",
        json={
            "revision": series["revision"],
            "requestKey": "ai-plan",
            "episodeIds": [episode["id"]],
            "instruction": "加强犹豫，其他部分不变",
        },
    )
    assert proposal.status_code == 200, proposal.text
    pending = proposal.json()
    assert "studio_series_suggest" in pending["prompt"]
    blocked = await client.post(
        f"{ROOT}/series/{series['id']}/episodes/{episode['id']}/confirm",
        json={
            "revision": pending["revision"],
            "requestKey": "confirm-with-pending-ai",
            "projectRevision": episode["projectRevision"],
        },
    )
    assert blocked.status_code == 409 and "待处理的编排建议" in blocked.text
    refreshed = (await client.get(f"{ROOT}/series/{series['id']}/proposals")).json()[0]
    assert refreshed["prompt"] == pending["prompt"] and refreshed["revision"] == pending["revision"]
    service = SeriesProposalService(SeriesService(app.state.services.studio))
    suggestion = SuggestSeriesProposal.model_validate(
        {
            "proposalId": pending["id"],
            "episodes": [
                {
                    "episodeId": episode["id"],
                    "story": {**base, "development": "啵啵合上地图，犹豫着没有开口"},
                }
            ],
        }
    )
    with pytest.raises(DomainError, match="本会话未授权"):
        await service.suggest(account, other["projectId"], suggestion)
    await service.suggest(account, episode["projectId"], suggestion)
    await service.suggest(account, episode["projectId"], suggestion)
    edited = await client.patch(
        f"{ROOT}/series/{series['id']}/episodes/{episode['id']}",
        json={
            "revision": pending["revision"],
            "requestKey": "manual-ending",
            "title": episode["title"],
            "story": {**base, "ending": "用户手工保留的结尾"},
        },
    )
    assert edited.status_code == 200, edited.text
    series = edited.json()
    resolution = {
        "revision": series["revision"],
        "requestKey": "adopt-development",
        "action": "apply",
        "selected": [{"episodeId": episode["id"], "fields": ["development"]}],
    }
    adopted = await client.post(
        f"{ROOT}/series/{series['id']}/proposals/{pending['id']}/resolve", json=resolution
    )
    assert adopted.status_code == 200, adopted.text
    series = adopted.json()
    changed = series["episodes"][0]
    assert changed["story"]["ending"] == "用户手工保留的结尾"
    assert changed["story"]["development"] == "啵啵合上地图，犹豫着没有开口"
    assert series["episodes"][1]["story"] == other["story"]
    assert (await client.get(f"{ROOT}/projects/{episode['projectId']}")).json()["document"][
        "script"
    ] == ""
    retry = await client.post(
        f"{ROOT}/series/{series['id']}/proposals/{pending['id']}/resolve", json=resolution
    )
    assert retry.json() == adopted.json()
    proposal = await client.post(
        f"{ROOT}/series/{series['id']}/proposals",
        json={
            "revision": series["revision"],
            "requestKey": "second-plan",
            "episodeIds": [episode["id"]],
            "instruction": "修改结尾",
        },
    )
    pending = proposal.json()
    await service.suggest(
        account,
        episode["projectId"],
        SuggestSeriesProposal.model_validate(
            {
                "proposalId": pending["id"],
                "episodes": [
                    {"episodeId": episode["id"], "story": {**changed["story"], "ending": "AI结尾"}}
                ],
            }
        ),
    )
    manual = await client.patch(
        f"{ROOT}/series/{series['id']}/episodes/{episode['id']}",
        json={
            "revision": pending["revision"],
            "requestKey": "manual-overlap",
            "title": episode["title"],
            "story": {**changed["story"], "ending": "另一次手工结尾"},
        },
    )
    conflict = await client.post(
        f"{ROOT}/series/{series['id']}/proposals/{pending['id']}/resolve",
        json={
            "revision": manual.json()["revision"],
            "requestKey": "conflict",
            "action": "apply",
            "selected": [{"episodeId": episode["id"], "fields": ["ending"]}],
        },
    )
    assert conflict.status_code == 409 and "手工修改" in conflict.text


async def test_series_settings_are_pinned_and_explicitly_adopted(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    _, client = platform
    await bootstrap(client)
    role = (
        await client.post(
            ROOT + "/assets",
            json={
                "kind": "character",
                "name": "小白",
                "description": "原始白色造型",
                "voice": "voice-a",
            },
        )
    ).json()["id"]
    series = await create_series(client)
    result = await client.put(
        f"{ROOT}/series/{series['id']}/settings",
        json={
            "revision": series["revision"],
            "requestKey": "settings-one",
            "assetVersionIds": [role],
        },
    )
    assert result.status_code == 200, result.text
    series = await add_episode(client, result.json(), "第一集")
    series = await add_episode(client, series, "第二集")
    one, two = series["episodes"]
    documents = [
        (await client.get(f"{ROOT}/projects/{ep['projectId']}")).json() for ep in (one, two)
    ]
    assert documents[0]["document"]["assets"] != documents[1]["document"]["assets"]
    second = (
        await client.post(
            ROOT + "/assets",
            json={
                "kind": "character",
                "name": "小白",
                "description": "蓝色太空服",
                "voice": "voice-b",
                "parent": role,
            },
        )
    ).json()["id"]
    result = await client.put(
        f"{ROOT}/series/{series['id']}/settings",
        json={
            "revision": series["revision"],
            "requestKey": "settings-two",
            "assetVersionIds": [second],
        },
    )
    assert result.status_code == 200, result.text
    series = result.json()
    assert all(ep["settingsRevision"] == 2 for ep in series["episodes"])
    assert series["settingsRevision"] == 3
    applied = await client.post(
        f"{ROOT}/series/{series['id']}/settings/apply",
        json={
            "revision": series["revision"],
            "requestKey": "apply-first",
            "episodeIds": [one["id"]],
            "projectRevisions": {one["projectId"]: one["projectRevision"]},
        },
    )
    assert applied.status_code == 200, applied.text
    assert [ep["settingsRevision"] for ep in applied.json()["episodes"]] == [3, 2]
    after = [(await client.get(f"{ROOT}/projects/{ep['projectId']}")).json() for ep in (one, two)]
    chosen = [
        {asset["id"]: asset for asset in project["assets"]}[project["document"]["assets"][0]]
        for project in after
    ]
    assert [asset["description"] for asset in chosen] == ["蓝色太空服", "原始白色造型"]

"""分集结构操作使用真实 PostgreSQL；源工程、稳定归属与媒体历史必须保留。"""

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient

from app.modules.studio.entity.do.models import MediaJob

ROOT = "/api/studio"


async def test_import_split_merge_remove_keep_original_engineering(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    project = (await client.post(ROOT + "/projects", json={"title": "既有专业作品"})).json()
    document = {
        "script": "原作品全文保持不变",
        "shots": [{"id": "original-shot", "action": "原镜头动作"}],
    }
    save = await client.put(
        f"{ROOT}/projects/{project['id']}", json={"revision": 1, "document": document}
    )
    assert save.status_code == 200, save.text
    original = (await client.get(f"{ROOT}/projects/{project['id']}")).json()
    series = (
        await client.post(
            ROOT + "/series", json={"title": "结构测试", "requestKey": "series-structure"}
        )
    ).json()
    imported_body = {
        "revision": series["revision"],
        "requestKey": "import-film",
        "projectId": project["id"],
        "projectRevision": original["revision"],
    }
    imported = await client.post(f"{ROOT}/series/{series['id']}/import-episode", json=imported_body)
    assert imported.status_code == 200, imported.text
    series = imported.json()
    assert series["episodes"][0]["projectId"] == project["id"]
    assert series["episodes"][0]["projectRevision"] == original["revision"]
    assert (
        await client.post(f"{ROOT}/series/{series['id']}/import-episode", json=imported_body)
    ).json() == series
    assert (await client.get(ROOT + "/works")).json()["total"] == 1
    second_series = (
        await client.post(ROOT + "/series", json={"title": "另一剧", "requestKey": "other-series"})
    ).json()
    duplicate = await client.post(
        f"{ROOT}/series/{second_series['id']}/import-episode",
        json={**imported_body, "revision": second_series["revision"], "requestKey": "import-again"},
    )
    assert duplicate.status_code == 409
    episode = series["episodes"][0]
    split = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans",
        json={
            "revision": series["revision"],
            "requestKey": "split-preview",
            "action": "split",
            "episodeIds": [episode["id"]],
            "episodes": [
                {"title": "出发", "story": {"synopsis": "发现飞船"}},
                {"title": "月球", "story": {"synopsis": "抵达月球"}},
            ],
        },
    )
    assert split.status_code == 200, split.text
    plan = split.json()
    assert plan["sourceEpisodes"][0]["shots"] == 1
    assert "不会自动搬入" in plan["notice"]
    unchanged = (await client.get(f"{ROOT}/series/{series['id']}")).json()
    assert unchanged["revision"] == series["revision"] and len(unchanged["episodes"]) == 1
    confirmed_body = {
        "revision": series["revision"],
        "requestKey": "split-confirm",
        "planHash": plan["planHash"],
    }
    invalid = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans/{plan['id']}/confirm",
        json={**confirmed_body, "planHash": "0" * 64},
    )
    assert invalid.status_code == 409
    confirmed = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans/{plan['id']}/confirm", json=confirmed_body
    )
    assert confirmed.status_code == 200, confirmed.text
    series = confirmed.json()
    assert len(series["episodes"]) == 2 and len(series["archivedEpisodes"]) == 1
    assert all(ep["shots"] == 0 and ep["projectId"] != project["id"] for ep in series["episodes"])
    assert (
        await client.post(
            f"{ROOT}/series/{series['id']}/structure-plans/{plan['id']}/confirm",
            json=confirmed_body,
        )
    ).json() == series
    after = (await client.get(f"{ROOT}/projects/{project['id']}")).json()
    assert after["document"] == original["document"] and after["revision"] == original["revision"]
    context = (await client.get(f"{ROOT}/projects/{project['id']}/episode-context")).json()
    assert context["archived"] and context["locked"]
    denied = await client.put(
        f"{ROOT}/projects/{project['id']}",
        json={"revision": after["revision"], "document": after["document"]},
    )
    assert denied.status_code == 409 and "历史" in denied.text
    merge = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans",
        json={
            "revision": series["revision"],
            "requestKey": "merge-preview",
            "action": "merge",
            "episodeIds": [ep["id"] for ep in series["episodes"]],
            "episodes": [{"title": "出发到月球", "story": {"synopsis": "发现飞船并抵达月球"}}],
        },
    )
    assert merge.status_code == 200, merge.text
    plan = merge.json()
    merged = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans/{plan['id']}/confirm",
        json={
            "revision": series["revision"],
            "requestKey": "merge-confirm",
            "planHash": plan["planHash"],
        },
    )
    assert merged.status_code == 200, merged.text
    series = merged.json()
    assert len(series["episodes"]) == 1 and len(series["archivedEpisodes"]) == 3
    episode = series["episodes"][0]
    async with app.state.services.studio.database.sessions.begin() as session:
        session.add(
            MediaJob(
                id="unknown-structure",
                project=episode["projectId"],
                request_key="unknown",
                subject="shot",
                kind="video",
                revision=1,
                state="unknown",
                payload={},
            )
        )
    remove_body = {
        "revision": series["revision"],
        "requestKey": "remove",
        "projectRevision": episode["projectRevision"],
    }
    denied = await client.post(
        f"{ROOT}/series/{series['id']}/episodes/{episode['id']}/remove", json=remove_body
    )
    assert denied.status_code == 409 and "待核对" in denied.text
    async with app.state.services.studio.database.sessions.begin() as session:
        job = await session.get(MediaJob, "unknown-structure")
        assert job is not None
        job.state = "unaccepted"
    removed = await client.post(
        f"{ROOT}/series/{series['id']}/episodes/{episode['id']}/remove", json=remove_body
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["episodes"] == [] and len(removed.json()["archivedEpisodes"]) == 4
    assert (await client.get(ROOT + "/works")).json()["total"] == 2
    assert (await client.get(f"{ROOT}/projects/{episode['projectId']}")).status_code == 200


async def test_structure_confirmation_rechecks_source_and_delivery(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    series = (
        await client.post(
            ROOT + "/series",
            json={
                "title": "冲突测试",
                "requestKey": "conflict-series",
                "plannedEpisodes": 2,
                "createEpisodeDrafts": True,
            },
        )
    ).json()
    one, two = series["episodes"]
    split = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans",
        json={
            "revision": series["revision"],
            "requestKey": "split-before-delivery",
            "action": "split",
            "episodeIds": [one["id"]],
            "episodes": [
                {"title": "开篇", "story": {"synopsis": "开始"}},
                {"title": "续篇", "story": {"synopsis": "继续"}},
            ],
        },
    )
    assert split.status_code == 200, split.text
    split_plan = split.json()
    body = {
        "revision": series["revision"],
        "requestKey": "merge-before-edit",
        "action": "merge",
        "episodeIds": [one["id"], two["id"]],
        "episodes": [{"title": "合并草稿", "story": {"synopsis": "新的故事"}}],
    }
    preview = await client.post(f"{ROOT}/series/{series['id']}/structure-plans", json=body)
    assert preview.status_code == 200, preview.text
    plan = preview.json()
    project = (await client.get(f"{ROOT}/projects/{one['projectId']}")).json()
    modified = {**project["document"], "script": "用户在另一页编辑的正文"}
    assert (
        await client.put(
            f"{ROOT}/projects/{one['projectId']}",
            json={"revision": project["revision"], "document": modified},
        )
    ).status_code == 200
    conflict = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans/{plan['id']}/confirm",
        json={
            "revision": series["revision"],
            "requestKey": "merge-stale",
            "planHash": plan["planHash"],
        },
    )
    assert conflict.status_code == 409 and "工程" in conflict.text
    unchanged = (await client.get(f"{ROOT}/series/{series['id']}")).json()
    assert len(unchanged["episodes"]) == 2 and not unchanged["archivedEpisodes"]
    async with app.state.services.studio.database.sessions.begin() as session:
        session.add(
            MediaJob(
                id="delivered-structure",
                project=two["projectId"],
                request_key="export",
                subject="export",
                kind="export",
                revision=two["projectRevision"],
                state="ready",
                payload={},
            )
        )
    denied = await client.post(
        f"{ROOT}/series/{series['id']}/episodes/{two['id']}/remove",
        json={
            "revision": series["revision"],
            "requestKey": "remove-delivered",
            "projectRevision": two["projectRevision"],
        },
    )
    assert denied.status_code == 409 and "已交付" in denied.text
    # 与源集无关的后续集刚交付，也不能在确认时被结构变更悄悄改集序。
    # 第一个旧预览源修订已变化，因此重新准备一个可用预览后再模拟第二集交付。
    async with app.state.services.studio.database.sessions.begin() as session:
        job = await session.get(MediaJob, "delivered-structure")
        assert job is not None
        await session.delete(job)
    split = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans",
        json={
            "revision": series["revision"],
            "requestKey": "split-latest-before-delivery",
            "action": "split",
            "episodeIds": [one["id"]],
            "episodes": split_plan["episodes"],
        },
    )
    assert split.status_code == 200, split.text
    split_plan = split.json()
    async with app.state.services.studio.database.sessions.begin() as session:
        session.add(
            MediaJob(
                id="later-delivered-structure",
                project=two["projectId"],
                request_key="later-export",
                subject="export",
                kind="export",
                revision=two["projectRevision"],
                state="ready",
                payload={},
            )
        )
    conflict = await client.post(
        f"{ROOT}/series/{series['id']}/structure-plans/{split_plan['id']}/confirm",
        json={
            "revision": series["revision"],
            "requestKey": "split-after-delivery",
            "planHash": split_plan["planHash"],
        },
    )
    assert conflict.status_code == 409 and "锁定集" in conflict.text

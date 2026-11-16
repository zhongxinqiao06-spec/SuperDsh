"""两角色四镜验收，重排、并发版本、局部修改与素材版本均走实际 API 和 PostgreSQL。"""

from copy import deepcopy

from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient


async def test_studio_editing_and_ownership(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    auth = await bootstrap(client)
    root = "/api/studio"
    account = await app.state.services.identity.authenticate(auth["accessToken"])
    assert (
        "products.office" in account.permissions and "products.entertainment" in account.permissions
    )

    async def create(name: str) -> str:
        response = await client.post(root + "/projects", json={"title": name})
        assert response.status_code == 200, response.text
        return str(response.json()["id"])

    a, b = await create("夜站"), await create("晨光")

    async def asset(name: str, **kwargs: str) -> str:
        response = await client.post(
            root + "/assets", json={"kind": "character", "name": name, **kwargs}
        )
        assert response.status_code == 200, response.text
        return str(response.json()["id"])

    role = await asset("小林", description="蓝外套", voice="voice-a")
    second = await asset("小禾", voice="voice-b")
    variant = await asset("小林雨衣", parent=role, project=a)

    def doc(roles: list[str]) -> dict:
        return {
            "assets": roles,
            "shots": [
                {
                    "id": f"shot{i}",
                    "action": f"站台 {i}",
                    "references": [roles[0]],
                    "lines": [{"id": f"line{i}", "text": "出发吧", "role": roles[i % 2]}],
                }
                for i in range(4)
            ],
        }

    async def save(project: str, rev: int, value: dict) -> int:
        return (
            await client.put(
                f"{root}/projects/{project}", json={"revision": rev, "document": value}
            )
        ).status_code

    assert await save(b, 1, doc([role, second])) == 200
    assert await save(a, 1, doc([variant, second])) == 200
    assert await save(a, 1, doc([role, second])) == 409
    assert await save(b, 2, doc([variant, second])) == 422
    project = (await client.get(f"{root}/projects/{a}")).json()
    original = deepcopy(project["document"])
    original["shots"][0]["trimEnd"] = 3200
    assert await save(a, 2, original) == 200
    chat = await client.post(f"{root}/projects/{a}/conversation")
    assert chat.status_code == 200, chat.text
    session = chat.json()["sessionId"]
    # 办公端沿用历史分页与全量入口，双产品账号的导演会话只出现在娱乐清单。
    for endpoint in ("/api/sessions", "/api/sessions/list"):
        assert session not in {s["id"] for s in (await client.get(endpoint)).json()["sessions"]}
    entertainment = await client.get("/api/sessions", params={"product": "entertainment"})
    assert session in {s["id"] for s in entertainment.json()["sessions"]}
    assert (await client.post(f"{root}/projects/{a}/conversation")).json()["sessionId"] == session
    await app.state.services.studio_agent.execute(
        account,
        "studio_edit",
        {"revision": 3, "shotId": "shot2", "scene": "雨夜"},
        {},
        {"sessionId": session},
    )
    edited = (await client.get(f"{root}/projects/{a}")).json()
    current = edited["document"]["shots"]
    assert current[0]["trimEnd"] == 3200 and current[2]["scene"] == "雨夜"
    assert current[2]["lines"] == original["shots"][2]["lines"] and current[2]["references"] == [
        variant
    ]
    changed = edited["document"]
    changed["shots"].insert(0, changed["shots"].pop(2))
    assert await save(a, 4, changed) == 200
    restored = await client.post(f"{root}/projects/{a}/revisions/3/restore?revision=5")
    assert restored.json()["revision"] == 6
    other = (await client.get(f"{root}/projects/{b}")).json()
    versions = {asset["id"]: asset for asset in other["assets"]}
    selected = [versions[key] for key in other["document"]["assets"]]
    assert [asset["parent"] for asset in selected] == [role, second]
    assert all(asset["project"] == b for asset in selected)
    assert selected[0]["description"] == "蓝外套" and selected[0]["voice"] == "voice-a"
    assert (
        await client.post(
            f"{root}/projects/{a}/jobs",
            json={"revision": 6, "requestKey": "export", "export": True},
        )
    ).status_code == 422
    assert (await client.get(f"{root}/projects/{a}/media/unknown")).status_code == 401

    # AI 提议和人工采用是两个独立事务，可以只接受第一个镜头的变化。
    base = (await client.get(f"{root}/projects/{a}")).json()
    proposal = deepcopy(base["document"]["shots"])
    proposal[0]["scene"] = "黎明"
    proposal[1]["action"] = "应保留原动作"
    await app.state.services.studio_agent.execute(
        account,
        "studio_propose",
        {"revision": 6, "shots": proposal},
        {},
        {"sessionId": session},
    )
    pending = (await client.get(f"{root}/projects/{a}")).json()
    review = {
        "revision": 6,
        "proposalId": pending["proposal"]["id"],
        "selected": [proposal[0]["id"]],
    }
    assert (
        await client.post(f"{root}/projects/{a}/proposal/review", json=review)
    ).status_code == 200
    final = (await client.get(f"{root}/projects/{a}")).json()
    assert final["document"]["shots"][0]["scene"] == "黎明"
    assert final["document"]["shots"][1] == base["document"]["shots"][1]
    assert final["proposal"] is None

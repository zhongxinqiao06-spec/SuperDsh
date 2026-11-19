"""三种创作入口复用真实工具收据与认证会话；使用隔离数据库且不调用收费模型。"""

from copy import deepcopy
from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from jsonschema import Draft202012Validator

from app.infrastructure.errors import DomainError
from app.modules.skills.service.binding_service import parameters
from app.modules.skills.service.tool_execution_service import ToolExecutionService
from app.modules.studio.entity.vo.series_vo import SuggestSeriesProposal


def execution(app: FastAPI) -> ToolExecutionService:
    services = app.state.services
    return ToolExecutionService(
        app.state.database,
        services.resources,
        services.extensions,
        services.skills,
        services.evidence,
        "synthetic-modes-ai-key",
    )


def test_engine_tool_parameters_accept_nullable_fields_without_losing_json() -> None:
    converted = parameters(
        {
            "properties": {
                "sceneId": {"type": ["string", "null"], "description": "允许取消场次关联"},
                "episodes": {"type": "array", "items": {"type": "object"}},
                "proposalId": {"type": "string"},
            },
            "required": ["proposalId", "episodes"],
        }
    )
    assert converted == {
        "sceneId": {"type": "json", "description": "允许取消场次关联"},
        "episodes": {"type": "json", "description": "episodes", "required": True},
        "proposalId": {"type": "string", "description": "proposalId", "required": True},
    }


async def test_series_tool_scope_receipt_and_explicit_partial_adoption(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    services = app.state.services
    account = await services.identity.authenticate(login["accessToken"])
    response = await client.post(
        "/api/studio/series",
        json={
            "title": "两集星图",
            "plannedEpisodes": 2,
            "createEpisodeDrafts": True,
            "requestKey": "series-for-tools",
        },
    )
    assert response.status_code == 200, response.text
    series = response.json()
    one, two = series["episodes"]
    uri = "/api/studio/series/" + series["id"]
    response = await client.post(
        uri + "/proposals",
        json={
            "revision": series["revision"],
            "requestKey": "outline-first",
            "episodeIds": [one["id"]],
            "instruction": "梗概突出月球线索，保持其他段落",
        },
    )
    assert response.status_code == 200, response.text
    proposal = response.json()
    project_uri = "/api/studio/projects/" + proposal["projectId"]
    session = (await client.post(project_uri + "/conversation")).json()["sessionId"]
    other_session = (
        await client.post("/api/studio/projects/" + two["projectId"] + "/conversation")
    ).json()["sessionId"]
    ids = await services.resources.initialize_product(account, services.studio_agent.package)
    binding = await services.resources.bind(account, session, ids["director"])
    tool = next(item for item in binding.snapshots if item["id"] == ids["studio_series_suggest"])
    body = {
        "proposalId": proposal["id"],
        "episodes": [
            {
                "episodeId": one["id"],
                "story": {**one["story"], "synopsis": "月球线索出现", "ending": "未采用的结尾"},
            }
        ],
    }
    schema = tool["inputSchema"]
    Draft202012Validator(schema).validate(body)
    SuggestSeriesProposal.model_validate(body)
    assert tool["descriptor"]["mode"] == "draft"
    assert services.extensions.is_builtin_draft(tool["implementation"])
    for reference in (
        {**tool["implementation"], "sourceId": "untrusted.extension"},
        {**tool["implementation"], "version": "unregistered-version"},
    ):
        assert not services.extensions.is_builtin_draft(reference)
    for invalid in (
        {**body, "projectId": two["projectId"]},
        {**body, "episodes": []},
        {**body, "episodes": body["episodes"] * 21},
        {**body, "proposalId": ""},
        {
            **body,
            "episodes": [{**body["episodes"][0], "story": {"synopsis": "x" * 12001}}],
        },
    ):
        assert list(Draft202012Validator(schema).iter_errors(invalid))
    wrong_scope = {**body, "episodes": [{**body["episodes"][0], "episodeId": two["id"]}]}
    for actor, arguments, context, status in (
        (account, wrong_scope, {"sessionId": session}, 422),
        (account, body, {"sessionId": other_session}, 404),
        (replace(account, user_id="other-owner"), body, {"sessionId": session}, 403),
        (account, {**body, "projectId": two["projectId"]}, {"sessionId": session}, 422),
        (account, {**body, "proposalId": "../foreign"}, {"sessionId": session}, 422),
    ):
        with pytest.raises(DomainError) as rejected:
            await services.extensions.execute(actor, tool["implementation"], arguments, {}, context)
        assert rejected.value.status == status
    assert (await client.get(uri + "/proposals")).json()[0]["state"] == "waiting"
    baseline = (await client.get(project_uri)).json()["document"]
    runner = execution(app)
    # 回调的作品身份始终取冻结 binding；传入额外 sessionId 不会替换可信上下文。
    result = await runner.invoke(
        account, binding, tool, "series-suggestion", body, {"sessionId": other_session}
    )
    content = result["structuredContent"]
    assert (
        "confirmation" not in result and isinstance(content, dict) and content["state"] == "ready"
    )
    assert await runner.invoke(account, binding, tool, "series-suggestion", body, {}) == result
    ready = (await client.get(uri + "/proposals")).json()[0]
    assert ready["base"][0]["story"] == one["story"]
    assert ready["suggestions"][0]["story"]["synopsis"] == "月球线索出现"
    assert (await client.get(uri)).json()["episodes"][0]["story"] == one["story"]
    assert (await client.get(project_uri)).json()["document"] == baseline
    apply = {
        "revision": ready["revision"],
        "requestKey": "apply-synopsis",
        "action": "apply",
        "selected": [{"episodeId": one["id"], "fields": ["synopsis"]}],
    }
    adopted = await client.post(uri + "/proposals/" + proposal["id"] + "/resolve", json=apply)
    assert adopted.status_code == 200, adopted.text
    assert (
        await client.post(uri + "/proposals/" + proposal["id"] + "/resolve", json=apply)
    ).json() == adopted.json()
    first, second = adopted.json()["episodes"]
    assert first["story"] == {**one["story"], "synopsis": "月球线索出现"}
    assert second["story"] == two["story"]
    assert (await client.get(project_uri)).json()["document"] == baseline
    assert (await client.get("/api/studio/jobs")).json()["total"] == 0


async def test_quick_text_tool_apply_undo_keeps_prompt_and_document_in_sync(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    services = app.state.services
    account = await services.identity.authenticate(login["accessToken"])
    created = await client.post(
        "/api/studio/projects",
        json={"title": "快速文案", "creationMode": "quick", "requestKey": "quick-ai"},
    )
    assert created.status_code == 200, created.text
    uri = "/api/studio/projects/" + created.json()["id"]
    state = (await client.get(uri + "/quick")).json()
    original = "开头。原句。结尾。"
    response = await client.put(
        uri + "/quick",
        json={
            "revision": state["revision"],
            "requestKey": "save-original",
            "title": state["title"],
            "draft": {**state["draft"], "prompt": original, "aspect": "16:9"},
        },
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    response = await client.post(
        uri + "/text-edits",
        json={
            "revision": saved["revision"],
            "requestKey": "polish-selection",
            "scope": "selection",
            "start": 3,
            "end": 6,
            "instruction": "润色原句",
        },
    )
    assert response.status_code == 200, response.text
    edit = response.json()
    session = (await client.post(uri + "/conversation?purpose=text-edit")).json()["sessionId"]
    ids = await services.resources.initialize_product(account, services.studio_agent.text_package)
    binding = await services.resources.bind(account, session, ids["editor"])
    tool = next(item for item in binding.snapshots if item["id"] == ids["suggest"])
    result = await execution(app).invoke(
        account,
        binding,
        tool,
        "quick-suggest",
        {"editId": edit["id"], "replacement": "更好的句子。"},
        {},
    )
    assert "confirmation" not in result
    assert (await client.get(uri + "/quick")).json()["draft"]["prompt"] == original
    path = uri + "/text-edits/" + edit["id"] + "/resolve"
    apply = {"revision": saved["revision"], "requestKey": "apply-quick", "action": "apply"}
    applied = await client.post(path, json=apply)
    assert applied.status_code == 200, applied.text
    assert (await client.post(path, json=apply)).json() == applied.json()
    state = (await client.get(uri + "/quick")).json()
    assert state["draft"] == {**saved["draft"], "prompt": "开头。更好的句子。结尾。"}
    assert (await client.get(uri)).json()["document"]["script"] == state["draft"]["prompt"]
    changed = await client.put(
        uri + "/quick",
        json={
            "revision": state["revision"],
            "requestKey": "manual-suffix",
            "title": state["title"],
            "draft": {**state["draft"], "prompt": state["draft"]["prompt"] + "署名。"},
        },
    )
    assert changed.status_code == 200, changed.text
    undone = await client.post(
        path,
        json={"revision": changed.json()["revision"], "requestKey": "undo-quick", "action": "undo"},
    )
    assert undone.status_code == 200, undone.text
    final = (await client.get(uri + "/quick")).json()
    assert final["draft"] == {**saved["draft"], "prompt": original + "署名。"}
    assert (await client.get(uri)).json()["document"]["script"] == final["draft"]["prompt"]
    assert (await client.get(uri + "/text-edits")).json()[0]["state"] == "undone"


async def test_explicit_refresh_adds_new_series_tool_without_rewriting_old_binding(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    services = app.state.services
    account = await services.identity.authenticate(login["accessToken"])
    current_manifest = deepcopy(services.extensions.builtins["starbridge.studio"])
    current_package = deepcopy(services.studio_agent.package)
    legacy_manifest, legacy_package = deepcopy(current_manifest), deepcopy(current_package)
    legacy_manifest["version"] = "0.0.0"
    legacy_manifest["tools"] = [
        tool for tool in legacy_manifest["tools"] if tool["id"] != "studio_series_suggest"
    ]
    legacy_package["resources"] = [
        item for item in legacy_package["resources"] if item["key"] != "studio_series_suggest"
    ]
    for item in legacy_package["resources"]:
        if item["kind"] == "agent":
            item["toolIds"].remove("studio_series_suggest")
        elif item["kind"] == "tool":
            item["implementation"]["version"] = legacy_manifest["version"]
    services.extensions.builtins["starbridge.studio"] = legacy_manifest
    services.studio_agent.package = legacy_package
    ids = await services.resources.initialize_product(account, legacy_package)
    agent = await services.resources.get(account, "agent", ids["director"])
    await services.resources.save(
        account, "agent", {**agent, "instructions": "用户保留的导演要求"}, ids["director"]
    )
    project = (await client.post("/api/studio/projects", json={"title": "旧包升级"})).json()
    uri = "/api/studio/projects/" + project["id"]
    response = await client.post(uri + "/conversation")
    assert response.status_code == 200, response.text
    session = response.json()["sessionId"]
    frozen = await services.resources.bind(account, session, ids["director"])
    services.extensions.builtins["starbridge.studio"] = current_manifest
    services.studio_agent.package = current_package
    current_ids = await services.resources.initialize_product(account, current_package)
    response = await client.post(uri + "/conversation")
    assert response.status_code == 409 and response.json()["code"] == "tool_implementation_changed"
    with pytest.raises(DomainError) as missing:
        await services.resources.get(account, "tool", current_ids["studio_series_suggest"])
    assert missing.value.status == 404
    refreshed = await client.post(uri + "/conversation/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["sessionId"] == session
    assert refreshed.json()["updatedTools"] == len(current_ids) - 1
    assert (await client.post(uri + "/conversation")).json()["sessionId"] == session
    updated = await services.resources.bind(account, session, ids["director"])
    assert any(item["id"] == current_ids["studio_series_suggest"] for item in updated.snapshots)
    assert all(item["id"] != current_ids["studio_series_suggest"] for item in frozen.snapshots)
    async with services.resources.repository.transaction() as tx:
        assert (await tx.binding(frozen.id)).snapshots == frozen.snapshots
    agent = await services.resources.get(account, "agent", ids["director"])
    assert agent["instructions"] == "用户保留的导演要求"
    assert (await client.post(uri + "/conversation/refresh")).json()["updatedTools"] == 0
    # 用户明确删除的新工具也有软删除记录；再次更新不会恢复它或改回用户引用。
    agent["toolIds"].remove(current_ids["studio_series_suggest"])
    await services.resources.save(account, "agent", agent, ids["director"])
    await services.resources.delete(account, "tool", current_ids["studio_series_suggest"])
    rejected = await client.post(uri + "/conversation/refresh")
    assert rejected.status_code == 409
    with pytest.raises(DomainError):
        await services.resources.get(account, "tool", current_ids["studio_series_suggest"])

"""导演公开字段、待审草稿、旧冻结绑定和安全错误的真实契约回归。"""

import json
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from jsonschema import Draft202012Validator

from app.infrastructure.errors import DomainError
from app.infrastructure.schema_validation import JsonSchemaValidator
from app.modules.extensions.service.validation import manifest_definition
from app.modules.skills.service.tool_execution_service import ToolExecutionService
from app.modules.studio.entity.vo.studio_vo import Document


def studio_manifest() -> dict:
    """从唯一生产元数据读取版本，不在测试装配复制发布版本。"""
    path = Path(__file__).resolve().parents[2] / "backend/resources/extensions/builtin-studio.json"
    return manifest_definition(json.loads(path.read_text(encoding="utf-8")))


def story_arguments() -> dict:
    """合成四场四镜；时长与文本偏移分别表达。"""
    return {
        "revision": 1,
        "script": "出发。椰林。海边。告别。",
        "scenes": [
            {"id": f"scene-{index}", "title": title}
            for index, title in enumerate(("出发", "椰林", "海边", "告别"))
        ],
        "shots": [
            {
                "id": f"shot-{index}",
                "action": title,
                "sceneId": f"scene-{index}",
                "scene": "海南·" + title,
                "duration": 5000,
                "lines": [],
            }
            for index, title in enumerate(("出发", "椰林", "海边", "告别"))
        ],
    }


def test_director_schema_exposes_scene_ids_text_offsets_and_dto_bounds() -> None:
    manifest = studio_manifest()
    tools = {tool["id"]: tool for tool in manifest["tools"]}
    schema = tools["studio_propose"]["inputSchema"]
    shot = schema["properties"]["shots"]["items"]["properties"]
    scene = schema["properties"]["scenes"]["items"]["properties"]
    line = shot["lines"]["items"]["properties"]
    assert {"sceneId", "scene", "lines", "trimStart", "trimEnd"}.issubset(shot)
    assert "scenes" in shot["sceneId"]["description"] and "UUID" in shot["scene"]["description"]
    assert "Unicode" in scene["scriptRange"]["properties"]["start"]["description"]
    assert (
        "省略" in scene["scriptRange"]["description"] and "未确认" in line["voice"]["description"]
    )
    assert tools["studio_propose"]["mode"] == "draft"
    assert all(
        tools[key]["mode"] == "action" for key in ("studio_asset", "studio_edit", "studio_generate")
    )
    assert "sceneId" in tools["studio_edit"]["inputSchema"]["properties"]
    body = story_arguments()
    body["scenes"][0]["scriptRange"] = {"start": 0, "end": 3}
    body["shots"][0]["lines"] = [{"role": "character-version", "text": "出发。", "voice": ""}]
    Draft202012Validator(schema).validate(body)
    assert (
        len(
            Document.model_validate(
                {key: value for key, value in body.items() if key != "revision"}
            ).shots
        )
        == 4
    )
    for invalid in ("0:00-0:05｜镜头1", {"start": -1, "end": 3}):
        wrong = deepcopy(body)
        wrong["scenes"][0]["scriptRange"] = invalid
        assert list(Draft202012Validator(schema).iter_errors(wrong))
    for duration in (999, 120001):
        wrong = deepcopy(body)
        wrong["shots"][0]["duration"] = duration
        assert list(Draft202012Validator(schema).iter_errors(wrong))


def test_tool_validation_reports_only_path_and_rule_configuration_stays_generic() -> None:
    schema = next(tool for tool in studio_manifest()["tools"] if tool["id"] == "studio_propose")[
        "inputSchema"
    ]
    body = story_arguments()
    body["scenes"][0]["scriptRange"] = "private-user-material-not-for-error"
    validator = JsonSchemaValidator()
    with pytest.raises(DomainError) as problem:
        validator.validate_tool_arguments(body, schema)
    assert problem.value.code == "tool_arguments_invalid"
    assert "scenes.0.scriptRange" in problem.value.detail and "type" in problem.value.detail
    assert (
        "private-user-material" not in problem.value.detail
        and body["script"] not in problem.value.detail
    )
    with pytest.raises(DomainError) as configuration:
        validator.validate(body, schema)
    assert configuration.value.detail == "value does not match configured schema"
    assert configuration.value.code is None


async def test_refresh_exposes_new_schema_preserves_prompt_and_old_snapshots(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    await bootstrap(client)
    services = app.state.services
    account = await services.identity.authenticate(client.headers["Authorization"][7:])
    current = deepcopy(services.extensions.builtins["starbridge.studio"])
    legacy = deepcopy(current)
    legacy["version"] = "0.0.0"
    proposal = next(tool for tool in legacy["tools"] if tool["id"] == "studio_propose")
    proposal["mode"] = "action"
    proposal["inputSchema"]["properties"]["shots"]["items"] = {"type": "object"}
    services.extensions.builtins["starbridge.studio"] = legacy
    project = (await client.post("/api/studio/projects", json={"title": "冻结字段升级"})).json()
    uri = "/api/studio/projects/" + project["id"]
    legacy_package = deepcopy(services.studio_agent.package)
    for resource in legacy_package["resources"]:
        if resource["kind"] == "tool":
            resource["implementation"]["version"] = legacy["version"]
    ids = await services.resources.initialize_product(account, legacy_package)
    agent = await services.resources.get(account, "agent", ids["director"])
    agent = await services.resources.save(
        account, "agent", {**agent, "instructions": "用户自己的导演说明"}, ids["director"]
    )
    session = (await client.post(uri + "/conversation")).json()["sessionId"]
    frozen = await services.resources.bind(account, session, ids["director"])
    services.extensions.builtins["starbridge.studio"] = current
    refreshed = await client.post(uri + "/conversation/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["sessionId"] == session
    updated = await services.resources.bind(account, session, ids["director"])
    tool = next(item for item in updated.snapshots if item["id"] == ids["studio_propose"])
    assert "sceneId" in tool["inputSchema"]["properties"]["shots"]["items"]["properties"]
    assert tool["descriptor"]["mode"] == "draft"
    original = next(item for item in frozen.snapshots if item["id"] == ids["studio_propose"])
    assert original["inputSchema"]["properties"]["shots"]["items"] == {"type": "object"}
    async with services.resources.repository.transaction() as tx:
        stored = await tx.binding(frozen.id)
        assert stored.snapshots == frozen.snapshots
    assert (await services.resources.get(account, "agent", ids["director"]))[
        "instructions"
    ] == agent["instructions"]
    with pytest.raises(DomainError) as old_execution:
        await services.extensions.bind(account, original["implementation"])
    assert old_execution.value.code == "tool_implementation_changed"


async def test_draft_proposal_safely_corrects_bad_input_without_mutating_project(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    services = app.state.services
    account = await services.identity.authenticate(client.headers["Authorization"][7:])
    project = (await client.post("/api/studio/projects", json={"title": "草案纠错与采用"})).json()
    uri = "/api/studio/projects/" + project["id"]
    session = (await client.post(uri + "/conversation")).json()["sessionId"]
    ids = await services.resources.initialize_product(account, services.studio_agent.package)
    binding = await services.resources.bind(account, session, ids["director"])
    tool = next(item for item in binding.snapshots if item["id"] == ids["studio_propose"])
    wrong = story_arguments()
    wrong["scenes"][0]["scriptRange"] = "private-timecode-content"
    with pytest.raises(DomainError) as schema_error:
        await services.extensions.execute(
            account, tool["implementation"], wrong, {}, {"sessionId": session}
        )
    assert schema_error.value.status == 422 and schema_error.value.code == "tool_arguments_invalid"
    with pytest.raises(DomainError) as dto_error:
        await services.studio_agent.execute(
            account, "studio_propose", wrong, {}, {"sessionId": session}
        )
    assert dto_error.value.status == 422 and dto_error.value.code == "studio_tool_arguments_invalid"
    assert (
        "scenes.0.scriptRange" in dto_error.value.detail
        and "private-timecode-content" not in dto_error.value.detail
    )
    baseline = (await client.get(uri)).json()
    assert baseline["proposal"] is None and baseline["document"]["shots"] == []
    execution = ToolExecutionService(
        app.state.database,
        services.resources,
        services.extensions,
        services.skills,
        services.evidence,
        "synthetic-contract-key",
    )
    result = await execution.invoke(account, binding, tool, "valid-draft", story_arguments(), {})
    assert "confirmation" not in result
    assert (
        await execution.invoke(account, binding, tool, "valid-draft", story_arguments(), {})
        == result
    )
    pending = (await client.get(uri)).json()
    assert pending["document"] == baseline["document"] and pending["proposal"] is not None
    # 保存建议不会带走其他写工具和付费工具的执行确认。
    for name in ("studio_asset", "studio_edit"):
        action = next(item for item in binding.snapshots if item["id"] == ids[name])
        waiting = await execution.invoke(account, binding, action, "waiting-" + name, {}, {})
        assert "confirmation" in waiting
    generate = next(item for item in binding.snapshots if item["id"] == ids["studio_generate"])
    with monkeypatch.context() as patch:
        prepare = AsyncMock(
            return_value={
                "structuredContent": {"plan": {"title": "合成收费计划"}, "planHash": "a" * 64}
            }
        )
        patch.setattr(services.extensions, "execute", prepare)
        waiting = await execution.invoke(
            account, binding, generate, "waiting-generation", {"revision": 1}, {}
        )
        assert prepare.await_args is not None
        assert "confirmation" in waiting and prepare.await_args.args[4]["phase"] == "prepare"
    proposal_id = pending["proposal"]["id"]
    comparison = (await client.get(uri + "/proposals/" + proposal_id)).json()
    response = await client.post(
        uri + "/proposals/" + proposal_id + "/review",
        json={
            "revision": comparison["revision"],
            "requestKey": "adopt-draft",
            "selected": [change["key"] for change in comparison["changes"]],
        },
    )
    assert response.status_code == 200, response.text
    adopted = (await client.get(uri)).json()["document"]
    assert len(adopted["shots"]) == 4 and all(
        shot["sceneId"] == f"scene-{index}" for index, shot in enumerate(adopted["shots"])
    )

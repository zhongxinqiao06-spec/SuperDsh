"""真实数据库方案编辑和来源复核；引用证据来自解析后的实际文件字节。"""

import base64
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from test_tool_execution_phase2 import prepared

from app.infrastructure.errors import DomainError
from app.modules.knowledge.service.source_chunks import source_chunks
from app.modules.skills.entity.vo.plan_dto import PlanRevisionInput
from app.modules.skills.service.binding_service import object_value
from app.modules.skills.service.plan_service import PlanService
from app.modules.skills.service.reference_service import ReferenceService, verify_answer
from app.modules.skills.service.stage_evidence_service import StageEvidenceService


async def test_plan_edit_invalidates_exact_confirmation_and_keeps_completed_history(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, skill_id, tool, tools = await prepared(platform)
    skills = application.state.services.skills
    run = await skills.start(account, binding.id, skill_id, "editable-plan")
    run = await skills.submit(account, run.id, run.version, {"brief": "edit initial plan"})
    application.state.services.extensions.execute = AsyncMock(return_value={"message": "executed"})
    before = await tools.invoke(account, binding, tool, "edit-call", {"input": "first"}, {})
    service = PlanService(tools)
    identifier = object_value(before["confirmation"])["receiptId"]
    assert isinstance(identifier, str)
    listed = (await service.listing(account, binding.session_id))["items"]
    assert isinstance(listed, list)
    assert object_value(listed[0])["version"] == 1
    revised = await service.revise(
        account,
        binding.session_id,
        identifier,
        PlanRevisionInput(
            version=1, document={"title": "changed", "arguments": {"input": "changed"}}
        ),
    )
    assert object_value(revised["plan"])["version"] == 2
    with pytest.raises(DomainError):
        await tools.invoke(
            account,
            binding,
            tool,
            "edit-call",
            {},
            {"phase": "confirm-execute", "confirmation": before["confirmation"]},
        )
    with pytest.raises(DomainError) as stale:
        await service.revise(
            account,
            binding.session_id,
            identifier,
            PlanRevisionInput(version=1, document={}),
        )
    assert stale.value.status == 409
    current = await tools.invoke(account, binding, tool, "edit-call", {"input": "changed"}, {})
    await tools.invoke(
        account,
        binding,
        tool,
        "edit-call",
        {},
        {"phase": "confirm-execute", "confirmation": current["confirmation"]},
    )
    saved = service.view(await service.read(account, binding.session_id, identifier))
    assert (
        saved["state"] == "completed"
        and object_value(saved["document"])["title"] == "changed"
        and saved["version"] == 2
    )
    assert application.state.services.extensions.execute.call_args.args[2] == {"input": "changed"}
    assert "_planRecord" not in object_value(saved["result"])
    with pytest.raises(DomainError):
        await service.revise(
            account,
            binding.session_id,
            identifier,
            PlanRevisionInput(version=2, document={}),
        )


async def test_reference_rechecks_real_asset_and_rejects_forged_quote(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, old_binding, skill_id, tool, tools = await prepared(platform)
    _, client = platform
    uploaded = await client.post(
        "/api/admin/agents/assets",
        json={
            "name": "来源.txt",
            "kind": "knowledge",
            "contentBase64": base64.b64encode(
                "受控来源原文：本季度收入为十二万元。".encode()
            ).decode(),
        },
    )
    assert uploaded.status_code == 201, uploaded.text
    asset = uploaded.json()["asset"]
    definition = next(item for item in old_binding.snapshots if item.get("kind") == "agent")
    saved = await client.put(
        f"/api/admin/agents/{definition['id']}",
        json={
            "name": definition["name"],
            "instructions": "使用真实资料逐字引用",
            "version": definition["version"],
            "toolIds": [tool["id"]],
            "skillIds": [skill_id],
            "knowledgeAssetIds": [asset["id"]],
            "published": True,
        },
    )
    assert saved.status_code == 200, saved.text
    binding = await application.state.services.resources.bind(
        account, "reference-session", str(definition["id"])
    )
    source = source_chunks(
        await application.state.services.agents.assets.get(account, asset["id"], True)
    )[0]
    application.state.services.extensions.execute = AsyncMock(
        return_value={"structuredContent": [source]}
    )
    run = await application.state.services.skills.start(
        account, binding.id, skill_id, "sources-stage"
    )
    await tools.invoke(
        account,
        binding,
        {**tool, "descriptor": {"mode": "read"}},
        "real-reference",
        {"query": "收入"},
        {},
    )
    references = ReferenceService(
        tools,
        application.state.services.conversations,
        application.state.services.knowledge,
    )
    values = await references.sources(account, binding.session_id)
    assert values[0]["sha256"] == asset["sha256"]
    assert (
        await references.sources(account, binding.session_id, str(values[0]["id"]), "十二万元")
    )[0]["content"] == source["content"]
    with pytest.raises(DomainError) as forged:
        await references.sources(account, binding.session_id, str(values[0]["id"]), "二十万元")
    assert forged.value.status == 422
    verified = verify_answer(
        {
            "id": "answer",
            "type": "message",
            "status": "done",
            "content": {"text": f"“十二万元”[{source['sourceId']}]"},
        },
        values,
    )
    assert verified["status"] == "references-checked" and verified["checkedQuotes"] == 1
    assert (
        verify_answer(
            {
                "id": "answer",
                "status": "done",
                "content": {"text": "“伪造”[src_unknown]"},
            },
            values,
        )["status"]
        == "invalid"
    )
    run = await application.state.services.skills.read(account, run.id)
    checked = await StageEvidenceService(
        application.state.services.evidence, application.state.services.knowledge
    ).validate(account, run, {"checks": ["sources"]}, {})
    assert checked[0]["passed"] is True

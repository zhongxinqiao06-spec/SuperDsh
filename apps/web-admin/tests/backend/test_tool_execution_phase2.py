"""真实数据库上的通用确认/收据与成果；受控执行器和真实 DSH 证据分开。"""

import asyncio
import hashlib
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from test_resources_and_skills import composition

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.bo.resources import Binding
from app.modules.skills.service.binding_service import object_value
from app.modules.skills.service.stage_evidence_service import StageEvidenceService
from app.modules.skills.service.tool_execution_service import ToolExecutionService


async def prepared(
    platform: tuple[FastAPI, AsyncClient],
) -> tuple[FastAPI, Account, Binding, str, dict[str, object], ToolExecutionService]:
    application, client = platform
    account, binding_id, skill_id, tool_id = await composition(application, client)
    services = application.state.services
    binding = await services.resources.authorize_binding(account, binding_id)
    tool = next(item for item in binding.snapshots if item["id"] == tool_id)
    tool = {**tool, "descriptor": {"mode": "action", "timeoutSeconds": 30}}
    execution = ToolExecutionService(
        application.state.database,
        services.resources,
        services.extensions,
        services.skills,
        services.evidence,
        "synthetic-control-signing-secret",
    )
    return application, account, binding, skill_id, tool, execution


async def test_action_requires_exact_confirmation_and_replays_receipt(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, _, tool, execution = await prepared(platform)
    invoke = AsyncMock(return_value={"structuredContent": {"completed": True}})
    application.state.services.extensions.execute = invoke
    plan = await execution.invoke(account, binding, tool, "stable-call", {"input": "first"}, {})
    assert "confirmation" in plan and invoke.await_count == 0
    assert (
        await execution.invoke(account, binding, tool, "stable-call", {"input": "first"}, {})
        == plan
    )
    with pytest.raises(DomainError) as conflict:
        await execution.invoke(account, binding, tool, "stable-call", {"input": "different"}, {})
    assert conflict.value.status == 409
    with pytest.raises(DomainError) as forged:
        await execution.invoke(
            account,
            binding,
            tool,
            "stable-call",
            {},
            {
                "phase": "confirm-execute",
                "confirmation": {"proof": "model-said-approved"},
            },
        )
    assert forged.value.status == 403 and invoke.await_count == 0
    trusted = {"phase": "confirm-execute", "confirmation": plan["confirmation"]}
    result = await execution.invoke(account, binding, tool, "stable-call", {}, trusted)
    assert result["structuredContent"] == {"completed": True}
    assert invoke.await_count == 1 and invoke.call_args.args[2] == {"input": "first"}
    assert await execution.invoke(account, binding, tool, "stable-call", {}, trusted) == result
    assert invoke.await_count == 1


async def test_concurrent_confirmation_and_unknown_results_never_repeat(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, _, tool, execution = await prepared(platform)
    started, release = asyncio.Event(), asyncio.Event()

    async def controlled(*_args: object) -> None:
        started.set()
        await release.wait()
        raise TimeoutError("synthetic network disconnected after send")

    invoke = AsyncMock(side_effect=controlled)
    application.state.services.extensions.execute = invoke
    plan = await execution.invoke(account, binding, tool, "unknown-call", {"task": "effect"}, {})
    trusted = {"phase": "confirm-execute", "confirmation": plan["confirmation"]}
    first = asyncio.create_task(
        execution.invoke(account, binding, tool, "unknown-call", {}, trusted)
    )
    await asyncio.wait_for(started.wait(), 3)
    with pytest.raises(DomainError) as duplicate:
        await execution.invoke(account, binding, tool, "unknown-call", {}, trusted)
    assert duplicate.value.code == "operation_outcome_unknown"
    release.set()
    with pytest.raises(TimeoutError):
        await first
    with pytest.raises(DomainError):
        await execution.invoke(account, binding, tool, "unknown-call", {}, trusted)
    assert invoke.await_count == 1


async def test_ordinary_artifact_has_real_receipt_and_no_fabricated_skill(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, _, tool, execution = await prepared(platform)
    root: Path = application.state.services.evidence.object_root / account.user_id
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    data = b"controlled actual artifact bytes"
    (root / "receipt.txt").write_bytes(data)
    invoke = AsyncMock(
        return_value={
            "message": "generated",
            "_pendingArtifacts": [
                {
                    "objectKey": "receipt.txt",
                    "filename": "receipt.txt",
                    "mediaType": "text/plain",
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "metadata": {"sources": []},
                }
            ],
        }
    )
    application.state.services.extensions.execute = invoke
    plan = await execution.invoke(account, binding, tool, "artifact-call", {}, {})
    result = await execution.invoke(
        account,
        binding,
        tool,
        "artifact-call",
        {},
        {"phase": "confirm-execute", "confirmation": plan["confirmation"]},
    )
    assert "_pendingArtifacts" not in result
    artifacts = result["artifacts"]
    assert isinstance(artifacts, list) and artifacts
    published = object_value(artifacts[0])
    artifact, path = await application.state.services.evidence.resolve_artifact(
        account, published["id"]
    )
    assert (
        artifact.run_id is None
        and artifact.session_id == binding.session_id
        and path.read_bytes() == data
    )
    stored, entry = await application.state.services.files.read(account, published["fileId"])
    assert stored == data and entry["sha256"] == artifact.sha256
    retried = await asyncio.gather(
        *[
            application.state.services.evidence.register_tool_artifact(
                account,
                artifact.metadata_json["receiptId"],
                {
                    "objectKey": "receipt.txt",
                    "filename": "receipt.txt",
                    "mediaType": "text/plain",
                    "sha256": artifact.sha256,
                },
            )
            for _ in range(3)
        ]
    )
    assert {item.metadata_json["fileId"] for item in retried} == {published["fileId"]}
    (root / "receipt.txt").write_bytes(b"tampered")
    with pytest.raises(DomainError, match="changed"):
        await application.state.services.evidence.resolve_artifact(account, artifact.id)


async def test_skill_confirmation_advances_exact_stage_and_old_revision_rejected(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, skill_id, tool, execution = await prepared(platform)
    skills = application.state.services.skills
    run = await skills.start(account, binding.id, skill_id, "skill-request")
    run = await skills.submit(account, run.id, run.version, {"brief": "controlled task"})
    invoke = AsyncMock(return_value={"structuredContent": {"completed": True}})
    application.state.services.extensions.execute = invoke
    plan = await execution.invoke(account, binding, tool, "stage-call", {"input": "frozen"}, {})
    assert (await skills.read(account, run.id)).state == "waiting-user"
    await execution.invoke(
        account,
        binding,
        tool,
        "stage-call",
        {},
        {"phase": "confirm-execute", "confirmation": plan["confirmation"]},
    )
    current = await skills.read(account, run.id)
    assert current.stage_index == 3 and current.state == "running" and current.pending_call is None
    assert invoke.await_count == 1
    await execution.invoke(
        account,
        binding,
        tool,
        "stage-call",
        {},
        {"phase": "confirm-execute", "confirmation": plan["confirmation"]},
    )
    assert invoke.await_count == 1


@pytest.mark.parametrize("interrupted", [True, False])
async def test_waiting_plan_interrupt_cancels_but_edit_revises(
    platform: tuple[FastAPI, AsyncClient],
    interrupted: bool,
) -> None:
    """中断撤销未执行方案并终结技能；正常修改方案仍走修订，不混淆两种用户意图。"""
    application, account, binding, skill_id, tool, execution = await prepared(platform)
    skills = application.state.services.skills
    run = await skills.start(account, binding.id, skill_id, "cancel-ppt-plan")
    run = await skills.submit(account, run.id, run.version, {"brief": "controlled task"})
    invoke = AsyncMock()
    application.state.services.extensions.execute = invoke
    plan = await execution.invoke(account, binding, tool, "waiting-plan", {"input": "frozen"}, {})
    trusted = {
        "phase": "reject-confirmation",
        "confirmation": plan["confirmation"],
        "cancelledByUser": interrupted,
    }
    first = await execution.invoke(account, binding, tool, "waiting-plan", {}, trusted)
    current = await skills.read(account, run.id)
    assert first["status"] == "cancelled" and current.pending_call is None
    assert current.state == ("cancelled" if interrupted else "running")
    version = current.version
    assert (await execution.invoke(account, binding, tool, "waiting-plan", {}, trusted))[
        "status"
    ] == "cancelled"
    assert (await skills.read(account, run.id)).version == version
    invoke.assert_not_awaited()


async def test_diagnostic_draft_remains_downloadable_but_cannot_satisfy_delivery(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, skill_id, tool, execution = await prepared(platform)
    services = application.state.services
    run = await services.skills.start(account, binding.id, skill_id, "draft-delivery")
    root: Path = services.evidence.object_root / account.user_id
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    validator = StageEvidenceService(services.evidence)
    for deliverable, filename in ((False, "diagnostic.txt"), (True, "revised.txt")):
        data = filename.encode()
        await asyncio.to_thread((root / filename).write_bytes, data)
        services.extensions.execute = AsyncMock(
            return_value={
                "structuredContent": {"deliverable": deliverable},
                "_pendingArtifacts": [
                    {
                        "objectKey": filename,
                        "filename": filename,
                        "mediaType": "text/plain",
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "metadata": {"deliverable": deliverable},
                    }
                ],
            }
        )
        pending = await execution.invoke(account, binding, tool, filename, {}, {})
        result = await execution.invoke(
            account,
            binding,
            tool,
            filename,
            {},
            {
                "phase": "confirm-execute",
                "confirmation": pending["confirmation"],
            },
        )
        artifacts = result["artifacts"]
        assert isinstance(artifacts, list)
        artifact = object_value(artifacts[0])
        assert artifact["deliverable"] is deliverable
        downloaded, _ = await services.files.read(account, artifact["fileId"])
        assert downloaded == data
        current = await services.skills.read(account, run.id)
        assert current.state == "running" and current.stage_index == 0
        if not deliverable:
            with pytest.raises(DomainError, match="verified deliverable"):
                await validator.validate(account, current, {"checks": ["artifact"]}, {})
        else:
            checked = await validator.validate(account, current, {"checks": ["artifact"]}, {})
            assert len(checked) == 1 and checked[0]["passed"] is True


async def test_concurrent_artifact_publication_keeps_one_file(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, _, _, _ = await prepared(platform)
    files = application.state.services.files
    values = await asyncio.gather(
        *[
            files.ingest_artifact(
                account,
                "concurrent.txt",
                b"actual artifact",
                "text/plain",
                "concurrent-artifact",
                binding.session_id,
            )
            for _ in range(6)
        ]
    )
    assert len({value["id"] for value in values}) == 1
    entries = await files.list_entries(account)
    assert len([item for item in entries["items"] if item["name"] == "concurrent.txt"]) == 1
    with pytest.raises(DomainError, match="conflict"):
        await files.ingest_artifact(
            account,
            "concurrent.txt",
            b"different bytes",
            "text/plain",
            "concurrent-artifact",
            binding.session_id,
        )


async def test_submit_auxiliary_action_confirms_without_advancing_stage(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    application, account, binding, skill_id, tool, execution = await prepared(platform)
    skills = application.state.services.skills
    run = await skills.start(account, binding.id, skill_id, "auxiliary-submit")
    invoke = AsyncMock(return_value={"structuredContent": {"generated": "auxiliary-resource"}})
    application.state.services.extensions.execute = invoke
    plan = await execution.invoke(
        account, binding, tool, "aux-effect", {"description": "synthetic layout"}, {}
    )
    waiting = await skills.read(account, run.id)
    assert waiting.state == "running" and waiting.stage_index == 0 and invoke.await_count == 0
    await execution.invoke(
        account,
        binding,
        tool,
        "aux-effect",
        {},
        {"phase": "confirm-execute", "confirmation": plan["confirmation"]},
    )
    after = await skills.read(account, run.id)
    assert after.state == "running" and after.stage_index == 0 and after.pending_call is None
    assert invoke.await_count == 1
    next_plan = await execution.invoke(
        account, binding, tool, "aux-next", {"description": "another layout"}, {}
    )
    await skills.submit(account, run.id, after.version, {"brief": "stage completed elsewhere"})
    with pytest.raises(DomainError, match="changed"):
        await execution.invoke(
            account,
            binding,
            tool,
            "aux-next",
            {},
            {"phase": "confirm-execute", "confirmation": next_plan["confirmation"]},
        )
    assert invoke.await_count == 1

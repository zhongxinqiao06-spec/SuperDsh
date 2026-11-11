"""非 Office 合成扩展验证配置、冻结版本、确认和未知结果，不调用外部模型。"""

from dataclasses import replace

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account


async def composition(application: FastAPI, client: AsyncClient) -> tuple[Account, str, str, str]:
    """公开 API 创建实现声明、密文配置、技能与发布 Agent，再由可信会话用例冻结。"""
    login = await bootstrap(client)
    identity = application.state.services.identity
    account = await identity.authenticate(str(login["accessToken"]))
    manifest = {
        "id": "synthetic.digest",
        "version": "fixture-revision",
        "runtime": "python",
        "entrypoint": "main.py",
        "tools": [
            {
                "id": "digest",
                "inputSchema": {"type": "object"},
                "configurationSchema": {
                    "type": "object",
                    "properties": {
                        "token": {"type": "string", "writeOnly": True},
                        "label": {"type": "string"},
                    },
                    "required": ["token"],
                    "additionalProperties": False,
                },
            }
        ],
    }
    response = await client.post(
        "/api/resources/extensions/install",
        json={"name": "Synthetic digest", "manifest": manifest},
    )
    assert response.status_code == 200, response.text
    extension = response.json()
    response = await client.post(
        "/api/resources/tools",
        json={
            "name": "Digest tool",
            "implementation": {
                "sourceId": extension["id"],
                "toolId": "digest",
                "version": manifest["version"],
            },
            "settings": {"token": "synthetic-tool-secret", "label": "first"},
        },
    )
    assert response.status_code == 200, response.text
    tool = response.json()
    assert tool["settings"] == {"label": "first"}
    assert tool["configuredSecrets"] == ["token"]
    stages = [
        {
            "id": "design",
            "operation": "submit",
            "toolIds": [tool["id"]],
            "inspectToolIds": [tool["id"]],
            "outputSchema": {
                "type": "object",
                "required": ["brief"],
                "properties": {"brief": {"type": "string"}},
            },
        },
        {"id": "plan", "operation": "prepare", "toolIds": [tool["id"]]},
        {"id": "generate", "operation": "execute", "toolIds": [tool["id"]]},
        {"id": "review", "operation": "review", "checks": ["schema"]},
    ]
    response = await client.post(
        "/api/resources/skills",
        json={
            "name": "Digest workflow",
            "requiredToolIds": [tool["id"]],
            "program": {"stages": stages, "maxRevisions": 2},
            "published": True,
        },
    )
    assert response.status_code == 200, response.text
    skill = response.json()
    agent = (
        await client.post(
            "/api/resources/agents",
            json={
                "name": "Digest assistant",
                "toolIds": [tool["id"]],
                "skillIds": [skill["id"]],
                "published": True,
            },
        )
    ).json()
    binding = await application.state.services.resources.bind(
        account, "trusted-synthetic-session", agent["id"]
    )
    return account, binding.id, skill["id"], tool["id"]


async def test_resource_encryption_snapshots_owner_and_seed_once(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    account, binding_id, _, tool_id = await composition(app, client)
    resources = app.state.services.resources
    async with app.state.database.engine.connect() as connection:
        row = (
            await connection.execute(
                text("select payload, secret_ciphertext from resources where id=:id"),
                {"id": tool_id},
            )
        ).one()
        assert "synthetic-tool-secret" not in str(row.payload)
        assert "synthetic-tool-secret" not in row.secret_ciphertext
    snapshot = await resources.authorize_binding(account, binding_id)
    tool = next(item for item in snapshot.snapshots if item["id"] == tool_id)
    response = await client.put(
        "/api/resources/tools/" + tool_id,
        json={
            "name": "Changed",
            "version": tool["version"],
            "implementation": tool["implementation"],
            "settings": {"label": "second"},
        },
    )
    assert response.status_code == 200, response.text
    assert next(
        item
        for item in (await resources.authorize_binding(account, binding_id)).snapshots
        if item["id"] == tool_id
    )["settings"] == {"label": "first"}
    assert (await resources.execution_configuration(account, binding_id, tool_id))[
        "label"
    ] == "first"
    assert (
        await client.put(
            "/api/resources/tools/" + tool_id,
            json={
                "name": "Stale",
                "version": 1,
                "implementation": tool["implementation"],
            },
        )
    ).status_code == 409
    with pytest.raises(DomainError, match="binding not found"):
        await resources.authorize_binding(replace(account, user_id="another-owner"), binding_id)
    initial = (await resources.list(account, "agent", 1, 100, "默认助手"))["items"]
    assert isinstance(initial, list) and len(initial) == 1
    await resources.delete(account, "agent", initial[0]["id"])
    await resources.initialize(account)
    assert (await resources.list(account, "agent", 1, 100, "默认助手"))["items"] == []
    # 第二阶段保留配置引用完整性：先拒绝删除正在被技能/智能体引用的工具；
    # 停用仍必须立即撤销既有绑定的执行资格。
    with pytest.raises(DomainError) as referenced:
        await resources.delete(account, "tool", tool_id)
    assert referenced.value.status == 409
    current = await resources.get(account, "tool", tool_id)
    await resources.save(account, "tool", {**current, "enabled": False}, tool_id)
    with pytest.raises(DomainError):
        await resources.authorize_binding(account, binding_id)


async def test_skill_auxiliary_confirmation_revision_receipts_and_restart(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    account, binding_id, skill_id, tool_id = await composition(app, client)
    skills = app.state.services.skills
    run = await skills.start(account, binding_id, skill_id, "stable-request")
    assert (await skills.start(account, binding_id, skill_id, "stable-request")).id == run.id
    with pytest.raises(DomainError, match="schema"):
        await skills.submit(account, run.id, run.version, {})
    run = await skills.begin_auxiliary(account, run.id, run.version, "aux-call", tool_id, "invoke")
    run = await skills.acknowledge(account, run.id, run.version, "aux-call", {"checked": True})
    assert run.stage_index == 0 and run.state == "running"
    run = await skills.submit(account, run.id, run.version, {"brief": "first"})
    run = await skills.prepare(account, run.id, run.version, {"digest": "sha256"})
    old_plan = run.plan_hash
    run = await skills.revise(account, run.id, run.version)
    with pytest.raises(DomainError, match="stale"):
        await skills.confirm(account, run.id, run.version, old_plan)
    run = await skills.submit(account, run.id, run.version, {"brief": "second"})
    run = await skills.prepare(account, run.id, run.version, {"digest": "sha256", "revision": 2})
    with pytest.raises(DomainError, match="confirmation"):
        await skills.begin_call(account, run.id, run.version, "paid-call", tool_id)
    run = await skills.confirm(account, run.id, run.version, run.plan_hash)
    run = await skills.begin_call(account, run.id, run.version, "paid-call", tool_id)
    with pytest.raises(DomainError):
        await skills.cancel(account, run.id, run.version)
    await skills.recover()
    run = await skills.read(account, run.id)
    assert run.state == "interrupted" and run.pending_call == "paid-call"
    with pytest.raises(DomainError):
        await skills.begin_call(account, run.id, run.version, "paid-call", tool_id)
    with pytest.raises(DomainError):
        await skills.begin_call(account, run.id, run.version, "new-id-must-not-retry", tool_id)
    run = await skills.acknowledge(
        account,
        run.id,
        run.version,
        "paid-call",
        {"verified": "actual-controlled-result"},
    )
    evidence_service = app.state.services.evidence
    evidence = await evidence_service.record_receipt(account, run.id, "paid-call")
    assert evidence.kind == "tool_receipt"
    artifact_root = app.state.settings.data_dir / "objects" / account.user_id
    artifact_root.mkdir(parents=True)
    (artifact_root / "result.txt").write_text("synthetic actual bytes", encoding="utf-8")
    artifact = await evidence_service.register_artifact(
        account, run.id, "paid-call", "result.txt", "text/plain"
    )
    assert (await evidence_service.resolve_artifact(account, artifact.id))[
        1
    ].read_text() == "synthetic actual bytes"
    with pytest.raises(DomainError, match="invalid managed"):
        await evidence_service.register_artifact(
            account, run.id, "paid-call", "../result.txt", "text/plain"
        )
    (artifact_root / "result.txt").write_text("tampered", encoding="utf-8")
    with pytest.raises(DomainError, match="content changed"):
        await evidence_service.resolve_artifact(account, artifact.id)
    with pytest.raises(DomainError, match="late"):
        await skills.acknowledge(account, run.id, run.version, "paid-call", {})
    run = await skills.submit(account, run.id, run.version, {"reviewed": True})
    assert run.state == "completed"
    another = await skills.start(account, binding_id, skill_id, "cancel-request")
    assert (await skills.cancel(account, another.id, another.version)).state == "cancelled"

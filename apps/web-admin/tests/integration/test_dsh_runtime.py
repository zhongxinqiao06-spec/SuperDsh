"""固定产品 Host 的真实 Python 接入验收，外部模型由受控本地 SSE 替代。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select, text

from app.infrastructure.database import Base, Database
from app.infrastructure.runtime_ownership import PostgresOwnershipProvider
from app.integrations.dsh.process_identity import machine_identity
from app.integrations.dsh.protocol import Fields, Json, RuntimeFailure, fields
from app.modules.conversations.service.interaction_protocol import (
    notice_view,
    response_input,
)
from app.modules.runtime.entity.do.models import RuntimeBatch
from app.modules.runtime.service.projection import SqlProjectionStore
from app.modules.runtime.service.supervisor import RuntimeSupervisor
from fixtures.dsh_models import ControlledModels


async def wait_for_event(store: SqlProjectionStore, owner: str, fragment: str) -> None:
    """从真正已提交批次寻找事实，不用 API 返回 accepted 冒充执行完成。"""
    async with asyncio.timeout(40):
        while True:
            events = await store.events(owner)
            if fragment in json.dumps(events, ensure_ascii=False):
                return
            await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_real_fixed_host_lifecycle_and_cancel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """覆盖真实 Host、持久投影、重复请求、单会话取消、工具回调和进程回收。"""
    url = os.environ.get("WEB_ADMIN_DSH_TEST_DATABASE_URL")
    if not url:
        pytest.fail("需要专用 WEB_ADMIN_DSH_TEST_DATABASE_URL；未运行真实引擎不计为通过")
    assert "web_admin_dsh_test" in url, "只允许专用 DSH 测试库"
    output = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    output.mkdir(parents=True, exist_ok=True)
    repository = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    runtime_repository = await asyncio.to_thread(
        Path(os.environ.get("WEB_ADMIN_DSH_TEST_RUNTIME_ROOT", repository)).resolve
    )
    preload = os.environ.get("WEB_ADMIN_DSH_TEST_NODE_PRELOAD")
    if preload:
        from app.integrations.dsh import process as process_module

        original_environment = process_module.child_environment
        preload_path = await asyncio.to_thread(Path(preload).resolve)
        assert preload_path.is_relative_to(output.parent)

        def isolated_environment(
            home: Path, workspace: Path, anchor: Path, gateway: Fields
        ) -> dict[str, str]:
            environment = original_environment(home, workspace, anchor, gateway)
            environment["NODE_OPTIONS"] = "--import=" + preload_path.as_uri()
            environment["WEB_ADMIN_ISOLATION_ROOT"] = str(output.parent)
            return environment

        monkeypatch.setattr(process_module, "child_environment", isolated_environment)
    state = output / ("runtime-" + uuid.uuid4().hex)
    database = Database(url)
    async with database.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    models = ControlledModels()
    owner = "synthetic-" + uuid.uuid4().hex
    calls: list[Fields] = []
    revoked = False
    tool_cancelled = asyncio.Event()
    tool_called = asyncio.Event()

    async def authorize(user: str) -> None:
        assert user == owner
        if revoked:
            raise RuntimeFailure("authorization_revoked", "合成授权已撤回", 403)

    async def tool_call(user: str, request: Fields) -> Json:
        await authorize(user)
        assert request["toolId"] == "validation_probe"
        assert request["revision"] == 7
        calls.append(request)
        tool_called.set()
        if fields(request.get("arguments")).get("value") == "confirmation":
            return {
                "plan": {"summary": "受控无副作用方案"},
                "confirmation": {
                    "receiptId": "confirmed-receipt",
                    "proof": "controlled-proof",
                    "planHash": "controlled-plan",
                },
            }
        if fields(request.get("context", {})).get("phase") == "confirm-execute":
            assert fields(fields(request["context"])["confirmation"])["proof"] == "controlled-proof"
            return {"value": "confirmed-result"}
        if fields(request.get("arguments")).get("value") == "cancel":
            try:
                await asyncio.Event().wait()
            finally:
                tool_cancelled.set()
        return {"value": "synthetic-result"}

    store = SqlProjectionStore(database.sessions)
    runner = RuntimeSupervisor(
        state,
        runtime_repository / "apps/desktop/plugins/harness/package.json",
        "node",
        str(json.loads((repository / "apps/desktop/package.json").read_text("utf-8"))["version"]),
        PostgresOwnershipProvider(database.engine),
        store,
        models,
        authorize,
        tool_call,
        heartbeat_seconds=0.5,
    )
    evidence: Fields = {
        "coverage": "real-fixed-host-controlled-model",
        "externalModel": False,
    }
    try:
        await runner.start()
        assert await runner.is_ready()
        assert runner.status(owner)["status"] == "stopped"
        assert not state.exists()
        await store.claim_execution(owner, "synthetic-live-owner", machine_identity())
        await store.attach_execution(owner, "synthetic-live-owner", os.getpid())
        with pytest.raises(RuntimeFailure) as fenced:
            await runner.prepare(owner)
        assert fenced.value.code == "runtime_recovery_required"
        assert not state.exists()
        await store.release_execution(owner, "synthetic-live-owner")
        evidence["liveExecutionFenceBlocksTakeover"] = True
        assert await store.reserve(owner, "synthetic-unknown-command", "synthetic-digest") == (
            True,
            None,
        )
        with pytest.raises(RuntimeFailure) as unknown:
            await store.reserve(owner, "synthetic-unknown-command", "synthetic-digest")
        assert unknown.value.code == "session_create_outcome_unknown"
        evidence["unknownReceiptNotReplayed"] = True
        await runner.prepare(owner)
        run = runner._hosts[owner]
        assert run.process.process is not None
        original_pid = run.process.process.pid
        assert (await runner.prepare(owner))["status"] == "running"
        reused_process = runner._hosts[owner].process.process
        assert reused_process is not None and reused_process.pid == original_pid
        with pytest.raises(RuntimeFailure, match="另一实例"):
            await PostgresOwnershipProvider(database.engine).acquire(owner)
        model_catalog = fields(await runner.call(owner, "catalog.listModels", {}))
        permission_catalog = fields(await runner.call(owner, "catalog.listPermissions", {}))
        presets = fields(await runner.call(owner, "catalog.listAgentPresets", {}))
        model_list = model_catalog.get("models")
        permissions = permission_catalog.get("permissions")
        assert isinstance(model_list, list) and model_list, model_catalog
        assert isinstance(permissions, list) and permissions, permission_catalog
        enabled = [fields(item) for item in permissions if fields(item).get("enabled")]
        controlled = next(
            fields(item)
            for item in model_list
            if fields(fields(item).get("metadata")).get("model") == "controlled"
        )
        selection = {
            "model": controlled["selectionId"],
            "permission": enabled[0]["selectionId"],
        }
        preset = fields(presets.get("configField", {})).get("default")
        command: Fields = {
            "sessionId": "session_normal",
            "clientMessageId": "normal-message",
            "content": "NORMAL_PROBE",
            "selections": selection,
        }
        # 不传业务预设，实际验证通用对话由平台补齐引擎目录声明的默认模式。
        assert isinstance(preset, str) and preset
        result = fields(await runner.call(owner, "session.createAndStart", command))
        assert result.get("accepted") is True, result
        assert await runner.call(owner, "session.createAndStart", command) == result
        with pytest.raises(RuntimeFailure) as conflict:
            await runner.call(owner, "session.createAndStart", {**command, "content": "different"})
        assert conflict.value.code == "idempotency_conflict"
        await wait_for_event(store, owner, "受控模型已完成")
        cancel_command = {
            **command,
            "sessionId": "session_cancel",
            "clientMessageId": "cancel-message",
            "content": "MODEL_CANCEL_PROBE",
        }
        cancelled = fields(await runner.call(owner, "session.createAndStart", cancel_command))
        assert cancelled.get("accepted") is True, cancelled
        await wait_for_event(store, owner, "正在等待取消")
        interrupted = fields(
            await runner.call(owner, "session.interrupt", {"sessionId": cancelled["sessionId"]})
        )
        assert interrupted.get("accepted") is True
        async with asyncio.timeout(15):
            await models.stream_cancelled.wait()
        assert run.process.process.returncode is None
        normal_state = fields(
            await runner.call(owner, "session.getState", {"sessionId": result["sessionId"]})
        )
        assert normal_state
        assert fields(normal_state.get("metadata"))["agentPreset"] == preset
        await runner.install_tool(
            owner,
            {
                "id": "validation_probe",
                "name": "验证探针",
                "revision": 7,
                "sessionIds": [
                    "session_tool",
                    "session_tool_cancel",
                    "session_confirmation",
                ],
                "description": "受控验证的无副作用工具",
                "parameters": {"value": {"type": "string", "required": True}},
            },
        )
        with pytest.raises(RuntimeFailure) as unbound:
            await runner._authorized_tool(
                owner,
                {
                    "toolId": "validation_probe",
                    "revision": 7,
                    "externalSessionId": result["externalSessionId"],
                    "callId": "synthetic-forged-call",
                    "arguments": {},
                },
            )
        assert unbound.value.code == "tool_session_not_bound"
        evidence["unboundToolSessionRejected"] = True
        await runner.install_preset(
            owner,
            {
                "id": "validation_frozen",
                "revision": 1,
                "name": "冻结合成工具预设",
                "description": "真实引擎预设安装验证",
                "prompt": "Use only the provided controlled validation tool when asked.",
                "toolIds": ["validation_probe"],
            },
        )
        tool_result = fields(
            await runner.call(
                owner,
                "session.createAndStart",
                {
                    **command,
                    "sessionId": "session_tool",
                    "clientMessageId": "tool-message",
                    "content": "TOOL_PROBE",
                    "agentPreset": "validation_frozen",
                },
            )
        )
        assert tool_result.get("accepted") is True, tool_result
        async with asyncio.timeout(30):
            await tool_called.wait()
        assert len(calls) == 1
        assert calls[0]["sessionId"] == "session_tool"
        evidence["frozenPresetInstalled"] = True
        await wait_for_event(store, owner, "synthetic-result")
        confirmation = fields(
            await runner.call(
                owner,
                "session.createAndStart",
                {
                    **command,
                    "sessionId": "session_confirmation",
                    "clientMessageId": "confirm-message",
                    "content": "CONFIRM_PROBE",
                    "agentPreset": "validation_frozen",
                },
            )
        )
        async with asyncio.timeout(25):
            while True:
                notices = fields(
                    await runner.call(
                        owner,
                        "session.getNotices",
                        {"sessionId": confirmation["sessionId"]},
                    )
                ).get("notices", [])
                pending = (
                    next(
                        (fields(item) for item in notices if fields(item).get("status") == "open"),
                        None,
                    )
                    if isinstance(notices, list)
                    else None
                )
                if pending:
                    break
                await asyncio.sleep(0.1)
        public = notice_view({key: value for key, value in pending.items()})
        actions = public["actions"]
        assert isinstance(actions, list)
        submit = next(
            fields(item)
            for item in actions
            if fields(fields(item).get("input", {})).get("uiSchema")
        )
        schema = fields(fields(submit["input"])["uiSchema"])
        questions = schema["questions"]
        assert isinstance(questions, list)
        question = fields(questions[0])
        options = question["options"]
        assert isinstance(options, list)
        assert len(calls) == 2, "等待用户时不能提前执行副作用"
        response = response_input(
            public,
            {"answers": {str(question["id"]): {"optionIds": [fields(options[0])["id"]]}}},
        )
        answered = fields(
            await runner.call(
                owner,
                "session.respondInteraction",
                {
                    "sessionId": confirmation["sessionId"],
                    "noticeId": str(public["id"]),
                    "actionId": submit["id"],
                    "inputData": fields(response),
                },
            )
        )
        assert answered.get("ok") is True, answered
        await wait_for_event(store, owner, "confirmed-result")
        assert len(calls) == 3
        evidence["nativePlanConfirmation"] = True
        tool_called.clear()
        pending_tool = fields(
            await runner.call(
                owner,
                "session.createAndStart",
                {
                    **command,
                    "sessionId": "session_tool_cancel",
                    "clientMessageId": "tool-cancel-message",
                    "content": "TOOL_CANCEL_PROBE",
                },
            )
        )
        async with asyncio.timeout(20):
            await tool_called.wait()
        assert len(calls) == 4
        await runner.call(owner, "session.interrupt", {"sessionId": pending_tool["sessionId"]})
        await asyncio.wait_for(tool_cancelled.wait(), 10)
        evidence["nativeToolCancellation"] = True

        # 既有会话切换必须改变真实 DSH 提示和工具作用域，不能只更换数据库显示名称。
        async def wait_idle(session_id: str) -> None:
            async with asyncio.timeout(20):
                while True:
                    state_value = fields(
                        await runner.call(
                            owner,
                            "session.getState",
                            {
                                "sessionId": session_id,
                            },
                        )
                    )
                    if fields(state_value.get("state", state_value)).get("status") in {
                        "idle",
                        "error",
                    }:
                        return
                    await asyncio.sleep(0.1)

        for identity, external, preset_id, revision in [
            ("session_normal", result["externalSessionId"], "validation_overlay", 1),
            ("session_tool", tool_result["externalSessionId"], "validation_frozen", 2),
        ]:
            await wait_idle(identity)
            await runner.install_preset(
                owner,
                {
                    "id": preset_id,
                    "revision": revision,
                    "name": "切换后的受控预设",
                    "prompt": "Use only the explicitly provided tools.",
                    "toolIds": [],
                    "externalSessionId": external,
                },
            )
            models.received_tools.clear()
            models.started.clear()
            before_switch = models.calls
            switched = fields(
                await runner.call(
                    owner,
                    "session.startTurn",
                    {
                        "sessionId": identity,
                        "externalSessionId": external,
                        "clientMessageId": "switch-" + identity,
                        "content": "NORMAL_PROBE_AFTER_SWITCH",
                    },
                )
            )
            assert switched.get("accepted") is True, switched
            async with asyncio.timeout(20):
                await models.started.wait()
            assert models.calls > before_switch
            await wait_idle(identity)
            assert models.received_tools == [], "旧工具不能从继承上下文泄漏到新绑定"
        evidence["existingSessionAgentRebinding"] = True
        # 关闭并重建原用户 Host：checkpoint 与原生命令收据必须保留，不重放模型调用。
        before_restart = models.calls
        await runner.stop(owner)
        assert run.process.process.returncode is not None
        await runner.prepare(owner)
        resumed = runner._hosts[owner]
        assert resumed.process.process is not None
        assert resumed.process.process.pid != original_pid
        assert await runner.call(owner, "session.createAndStart", command) == result
        assert models.calls == before_restart
        evidence["restartWithoutReplay"] = True
        evidence.update(
            {
                "hostPid": original_pid,
                "toolCalls": len(calls),
                "modelCalls": models.calls,
                "cancelledStreams": models.cancelled,
                "uniqueHostReused": True,
            }
        )
        async with database.sessions() as session:
            count = len(
                (
                    await session.scalars(select(RuntimeBatch).where(RuntimeBatch.owner == owner))
                ).all()
            )
        evidence["durableBatches"] = count
        revoked = True
        async with asyncio.timeout(20):
            await resumed.process.process.wait()
        evidence["revocationStoppedHost"] = True
        revoked = False
        await runner.prepare(owner)
        lost = runner._hosts[owner]
        assert lost.process.process is not None
        # 真实终止持锁 PG 连接，验证自动撤销执行能力和进程回收。
        from app.infrastructure.runtime_ownership import PostgresOwnership

        assert isinstance(lost.lease, PostgresOwnership)
        async with lost.lease._lock:
            backend_pid = await lost.lease.connection.scalar(text("SELECT pg_backend_pid()"))
            await lost.lease.connection.commit()
        async with database.engine.connect() as connection:
            await connection.execute(
                text("SELECT pg_terminate_backend(:pid)"), {"pid": backend_pid}
            )
            await connection.commit()
        async with asyncio.timeout(20):
            await lost.process.process.wait()
        evidence["leaseLossStoppedHost"] = True
        await runner.close()
        evidence["processExited"] = run.process.process.returncode is not None
        pin = json.loads(
            (repository / "apps/desktop/plugins/harness/package.json").read_text("utf-8")
        )
        evidence["dshVersion"] = pin["dependencies"]["@deepseek-ai/dsh"]
        evidence["adapterSha256"] = hashlib.sha256(
            (repository / "apps/web-admin/engine-adapter/dist/host.mjs").read_bytes()
        ).hexdigest()
        (output / "dsh-evidence.json").write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2), "utf-8"
        )
    except BaseException:
        print("CONTROLLED MODEL CALLS:", models.calls)
        print(
            "PROJECTION:",
            json.dumps(await store.events(owner), ensure_ascii=False)[-24000:],
        )
        for run in runner._hosts.values():
            print("FIXED HOST DIAGNOSTIC:", "".join(run.process.diagnostics))
        raise
    finally:
        await runner.close()
        async with database.engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
        await database.close()
        if state.exists():
            assert state.resolve().parent == output
            shutil.rmtree(state)

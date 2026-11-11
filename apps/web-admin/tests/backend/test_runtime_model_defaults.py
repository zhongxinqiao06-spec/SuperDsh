"""以注入目录、桥接与收据验证默认模型，不启动引擎、数据库或外部收费请求。"""

from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.integrations.dsh.protocol import Fields, Json, RuntimeFailure
from app.modules.devices.service.runtime_device_service import RuntimeDeviceService
from app.modules.runtime.dao.projection import ProjectionDao
from app.modules.runtime.entity.do.models import RuntimeReceipt
from app.modules.runtime.service.ports import ModelProvider, ProjectionStore
from app.modules.runtime.service.projection import SqlProjectionStore
from app.modules.runtime.service.supervisor import RunningHost, RuntimeSupervisor

OWNER = "synthetic-owner"
SCOPE = "a" * 64
SELECTION = "opaque-engine-selection"


@dataclass
class RuntimeFixture:
    """仅替换外部端口，监督器命令路径保持真实执行。"""

    runner: RuntimeSupervisor
    models: AsyncMock
    store: AsyncMock
    bridge: AsyncMock
    runtime_models: list[Json]
    runtime_presets: Fields
    runtime_permissions: Fields
    process: Mock
    params: Fields


@pytest.fixture
def runtime(tmp_path: Path) -> RuntimeFixture:
    models = AsyncMock(spec=ModelProvider)
    models.catalog.return_value = {
        "scope": SCOPE,
        "providers": [
            {
                "providerId": source + "-provider",
                "source": source,
                "name": source,
                "models": [{"modelId": "chat", "name": "同名配置"}],
            }
            for source in ("personal", "platform")
        ],
        "default": {"providerId": "personal-provider", "modelId": "chat"},
        "platformDefault": {"providerId": "platform-provider", "modelId": "chat"},
    }
    store = AsyncMock(spec=ProjectionStore)
    store.replay.return_value = (False, None)
    store.reserve.return_value = (True, None)
    bridge = AsyncMock()
    runtime_models: list[Json] = [
        {
            "id": "another-provider",
            "title": "另一模型",
            "selectionId": "another-provider",
            "enabled": True,
            "metadata": {"provider": f"superdsh-{SCOPE}-platform-provider", "model": "chat"},
        },
        {
            "id": SELECTION,
            "title": "默认模型",
            "selectionId": SELECTION,
            "enabled": True,
            "metadata": {"provider": f"superdsh-{SCOPE}-personal-provider", "model": "chat"},
        },
    ]

    runtime_presets: Fields = {
        "configField": {"default": "synthetic-engine-default"},
        "presets": [{"id": "synthetic-engine-default", "enabled": True}],
    }
    runtime_permissions: Fields = {
        "permissions": [
            {
                "id": "opaque-default-permission",
                "title": "默认权限",
                "selectionId": "opaque-default-permission",
                "enabled": True,
                "metadata": {"preset": "synthetic-permission"},
            }
        ],
    }

    async def request(method: str, params: Fields) -> Json:
        if method == "catalog.listModels":
            return {"runtime": "dsh", "revision": 1, "models": runtime_models}
        if method == "catalog.listAgentPresets":
            return runtime_presets
        if method == "catalog.listPermissions":
            return {"runtime": "dsh", "revision": 1, **runtime_permissions}
        return {"accepted": True}

    bridge.request.side_effect = request
    runner = RuntimeSupervisor(
        tmp_path,
        tmp_path,
        "synthetic-node",
        "synthetic-release",
        AsyncMock(),
        store,
        models,
        AsyncMock(),
        AsyncMock(),
    )
    lease = AsyncMock()
    lease.check.return_value = True
    process = Mock(workspace=tmp_path)
    process.runtime_defaults = AsyncMock(return_value={"permissionPreset": "synthetic-permission"})
    runner._hosts[OWNER] = RunningHost(
        OWNER,
        "synthetic-generation",
        lease,
        Mock(),
        process,
        bridge,
        Mock(),
        available=True,
    )
    params: Fields = {
        "sessionId": "synthetic-session",
        "clientMessageId": "synthetic-message",
        "content": "synthetic-content",
        "agentPreset": "explicit-agent",
        "selections": {"permission": "explicit-permission", "agentPreset": "explicit-agent"},
    }
    return RuntimeFixture(
        runner,
        models,
        store,
        bridge,
        runtime_models,
        runtime_presets,
        runtime_permissions,
        process,
        params,
    )


@pytest.mark.parametrize(
    "method", ["session.createAndStart", "session.startTurn", "session.updateSelections"]
)
@pytest.mark.parametrize("case", ["native", "foreign", "revoked", "disabled"])
async def test_unconfigured_selection_rejected_before_execution(
    runtime: RuntimeFixture, method: str, case: str
) -> None:
    """直接伪造或重放旧选择也不能绕过目录，错误不消耗发送收据。"""
    entry = cast(Fields, runtime.runtime_models[1])
    if case == "native":
        cast(Fields, entry["metadata"])["provider"] = "native-provider"
    elif case == "foreign":
        cast(Fields, entry["metadata"])["provider"] = f"superdsh-{'b' * 64}-personal-provider"
    elif case == "revoked":
        runtime.models.catalog.return_value["providers"] = []
    else:
        entry["enabled"] = False
    runtime.params["selections"] = {"model": SELECTION}
    with pytest.raises(RuntimeFailure) as error:
        await runtime.runner.call(OWNER, method, runtime.params)
    assert error.value.code == "model_selection_unavailable"
    assert all(call.args[0] != method for call in runtime.bridge.request.await_args_list)
    runtime.store.reserve.assert_not_awaited()


@pytest.mark.parametrize("enabled", [True, False])
async def test_reasoning_selection_requires_authorized_enabled_model(
    runtime: RuntimeFixture, enabled: bool
) -> None:
    entry = cast(Fields, runtime.runtime_models[1])
    entry["reasoningItems"] = [{"id": "high", "enabled": enabled, "selectionId": "opaque-high"}]
    runtime.params["selections"] = {"model": "opaque-high"}
    if enabled:
        await runtime.runner.call(OWNER, "session.updateSelections", runtime.params)
        assert runtime.bridge.request.await_args.args[1]["selections"] == {"model": "opaque-high"}
    else:
        with pytest.raises(RuntimeFailure, match="所选模型"):
            await runtime.runner.call(OWNER, "session.updateSelections", runtime.params)


async def test_sent_turn_replay_does_not_revalidate_changed_catalog(
    runtime: RuntimeFixture,
) -> None:
    runtime.params["selections"] = {"model": "revoked-after-send"}
    runtime.store.replay.return_value = (True, {"accepted": True})
    assert await runtime.runner.call(OWNER, "session.startTurn", runtime.params) == {
        "accepted": True
    }
    runtime.models.catalog.assert_not_awaited()
    runtime.bridge.request.assert_not_awaited()


async def test_default_never_picks_explicit_reasoning_variant(runtime: RuntimeFixture) -> None:
    variant = copy.deepcopy(cast(Fields, runtime.runtime_models[1]))
    variant["selectionId"] = "opaque-explicit-reasoning"
    cast(Fields, variant["metadata"])["reasoningEffort"] = "high"
    runtime.runtime_models.insert(0, variant)
    catalog = cast(Fields, await runtime.runner.call(OWNER, "catalog.listModels", {}))
    entries = cast(list[Fields], catalog["models"])
    assert [item["selectionId"] for item in entries if item["default"]] == [SELECTION]
    await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert runtime.bridge.request.await_args.args[1]["selections"]["model"] == SELECTION


async def test_new_session_uses_authorized_default_without_mutating_request(
    runtime: RuntimeFixture,
) -> None:
    """个人默认由目录确定；映射精确供应商且保留权限与智能体选择。"""
    original = copy.deepcopy(runtime.params)
    assert await runtime.runner.call(OWNER, "session.createAndStart", runtime.params) == {
        "accepted": True
    }
    submitted = runtime.bridge.request.await_args_list[-1].args[1]
    assert submitted["selections"] == {
        "permission": "explicit-permission",
        "agentPreset": "explicit-agent",
        "model": SELECTION,
    }
    assert runtime.params == original
    assert submitted["agentPreset"] == "explicit-agent"
    runtime.store.settle.assert_awaited_once()


async def test_general_chat_uses_engine_default_without_business_binding(
    runtime: RuntimeFixture,
) -> None:
    """不选业务智能体仍传递目录声明的原生模式，不硬编码预设名或改变显式权限。"""
    runtime.params.pop("agentPreset")
    original = copy.deepcopy(runtime.params)
    await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    submitted = runtime.bridge.request.await_args_list[-1].args[1]
    assert submitted["agentPreset"] == "synthetic-engine-default"
    assert submitted["selections"]["permission"] == "explicit-permission"
    assert runtime.params == original
    assert [call.args[0] for call in runtime.bridge.request.await_args_list] == [
        "catalog.listModels",
        "catalog.listAgentPresets",
        "session.createAndStart",
    ]


@pytest.mark.parametrize("failure", ["absent", "invalid", "missing", "disabled"])
async def test_engine_default_rejection_happens_before_submission(
    runtime: RuntimeFixture, failure: str
) -> None:
    """目录不能确认默认模式时拒绝，不选任意首项，也不留下未知执行占位。"""
    runtime.params.pop("agentPreset")
    if failure == "absent":
        runtime.runtime_presets["configField"] = {}
    elif failure == "invalid":
        runtime.runtime_presets["configField"] = {"default": True}
    elif failure == "missing":
        runtime.runtime_presets["presets"] = [{"id": "another-mode", "enabled": True}]
    else:
        runtime.runtime_presets["presets"] = [{"id": "synthetic-engine-default", "enabled": False}]
    with pytest.raises(RuntimeFailure) as caught:
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert caught.value.code == (
        "agent_default_invalid" if failure in {"absent", "invalid"} else "agent_default_unavailable"
    )
    runtime.store.reserve.assert_not_awaited()
    runtime.store.settle.assert_not_awaited()
    assert all(
        call.args[0] != "session.createAndStart" for call in runtime.bridge.request.await_args_list
    )


async def test_general_chat_replay_never_resolves_new_mode(runtime: RuntimeFixture) -> None:
    """完成收据优先于变化后的模式配置，不把重试变成第二次创建。"""
    runtime.params.pop("agentPreset")
    runtime.store.replay.return_value = (True, {"original": True})
    assert await runtime.runner.call(OWNER, "session.createAndStart", runtime.params) == {
        "original": True
    }
    runtime.bridge.request.assert_not_awaited()
    runtime.store.reserve.assert_not_awaited()


async def test_explicit_model_is_validated_without_changing_to_default(
    runtime: RuntimeFixture,
) -> None:
    runtime.params["selections"] = {
        "model": "another-provider",
        "permission": "explicit-permission",
    }
    await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    runtime.models.catalog.assert_awaited_once()
    assert runtime.bridge.request.await_args_list[0].args[0] == "catalog.listModels"
    assert runtime.bridge.request.await_args.args[1]["selections"] == runtime.params["selections"]
    runtime.process.runtime_defaults.assert_not_awaited()


async def test_existing_session_keeps_its_model(runtime: RuntimeFixture) -> None:
    """继续会话的模型归引擎持久状态管理，不受新默认值影响。"""
    await runtime.runner.call(OWNER, "session.startTurn", runtime.params)
    runtime.models.catalog.assert_not_awaited()
    runtime.store.replay.assert_awaited_once()
    runtime.process.runtime_defaults.assert_not_awaited()
    assert runtime.bridge.request.await_args.args[1]["selections"] == runtime.params["selections"]


async def test_all_defaults_follow_current_configuration(runtime: RuntimeFixture) -> None:
    """通用对话无需手动选择；权限默认来自配置，不能取第一项或硬编码权限名。"""
    runtime.params.pop("agentPreset")
    runtime.params["selections"] = {}
    values = runtime.runtime_permissions["permissions"]
    assert isinstance(values, list)
    values.insert(
        0,
        {
            "id": "other-permission",
            "selectionId": "opaque-other",
            "enabled": True,
            "metadata": {"preset": "other-permission"},
        },
    )
    original = copy.deepcopy(runtime.params)
    await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    submitted = runtime.bridge.request.await_args.args[1]
    assert submitted["agentPreset"] == "synthetic-engine-default"
    assert submitted["selections"] == {
        "model": SELECTION,
        "permission": "opaque-default-permission",
    }
    assert runtime.params == original
    runtime.process.runtime_defaults.return_value = {"permissionPreset": "other-permission"}
    await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert runtime.bridge.request.await_args.args[1]["selections"]["permission"] == "opaque-other"


@pytest.mark.parametrize(
    "failure", ["invalid", "missing", "disabled", "missing_selection", "timeout"]
)
async def test_permission_default_failure_does_not_submit(
    runtime: RuntimeFixture, failure: str
) -> None:
    """配置错误或读取失败都在提交之前拒绝，避免未知收据和意外权限升级。"""
    runtime.params["selections"] = {"model": SELECTION}
    if failure == "invalid":
        runtime.process.runtime_defaults.return_value = {"permissionPreset": True}
    elif failure == "missing":
        runtime.process.runtime_defaults.return_value = {"permissionPreset": "absent"}
    elif failure == "timeout":
        runtime.process.runtime_defaults.side_effect = RuntimeFailure(
            "permission_default_unavailable", "synthetic"
        )
    else:
        values = runtime.runtime_permissions["permissions"]
        assert isinstance(values, list)
        entry = cast(Fields, values[0])
        entry["enabled" if failure == "disabled" else "selectionId"] = (
            False if failure == "disabled" else None
        )
    with pytest.raises(RuntimeFailure) as error:
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert error.value.code == (
        "permission_default_invalid" if failure == "invalid" else "permission_default_unavailable"
    )
    runtime.store.reserve.assert_not_awaited()
    runtime.store.settle.assert_not_awaited()
    assert all(
        call.args[0] != "session.createAndStart" for call in runtime.bridge.request.await_args_list
    )


async def test_catalog_defaults_survive_browser_mapping(runtime: RuntimeFixture) -> None:
    """浏览器看到的默认项与首次提交解析一致，标记不污染原引擎目录。"""
    original = copy.deepcopy(runtime.runtime_permissions)
    for kind, method, key, selected in [
        ("model", "catalog.listModels", "models", SELECTION),
        ("permission", "catalog.listPermissions", "permissions", "opaque-default-permission"),
    ]:
        native = await runtime.runner.call(OWNER, method, {})
        mapped = RuntimeDeviceService.bridge_catalog(kind, native)
        entries = cast(list[Fields], mapped[key])
        defaults = [item for item in entries if item["default"]]
        assert len(defaults) == 1
        assert defaults[0]["selectionId"] == selected
    assert runtime.runtime_permissions == original


async def test_no_default_rejects_before_submission(runtime: RuntimeFixture) -> None:
    runtime.models.catalog.return_value = {"default": None}
    with pytest.raises(RuntimeFailure, match="尚未配置默认聊天模型"):
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    runtime.bridge.request.assert_not_awaited()
    runtime.store.reserve.assert_not_awaited()


async def test_platform_default_handles_absent_selections(runtime: RuntimeFixture) -> None:
    runtime.params.pop("selections")
    runtime.models.catalog.return_value["default"] = {
        "providerId": "platform-provider",
        "modelId": "chat",
    }
    await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert runtime.bridge.request.await_args.args[1]["selections"] == {
        "model": "another-provider",
        "permission": "opaque-default-permission",
    }


@pytest.mark.parametrize("failure", ["missing", "disabled", "wrong_scope", "missing_selection"])
async def test_unavailable_default_never_falls_back_or_reserves(
    runtime: RuntimeFixture, failure: str
) -> None:
    """缺少指定模型时在发送前失败，同一消息随后可以安全重试。"""
    chosen = cast(Fields, runtime.runtime_models[1])
    if failure == "missing":
        runtime.runtime_models.pop()
    elif failure == "disabled":
        chosen["enabled"] = False
    elif failure == "wrong_scope":
        cast(Fields, chosen["metadata"])["provider"] = "another-owner-provider"
    else:
        chosen["selectionId"] = None
    with pytest.raises(RuntimeFailure) as error:
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert error.value.code == "model_default_unavailable"
    runtime.store.reserve.assert_not_awaited()
    assert [call.args[0] for call in runtime.bridge.request.await_args_list] == [
        "catalog.listModels"
    ]


async def test_invalid_configured_default_fails_before_bridge(runtime: RuntimeFixture) -> None:
    runtime.models.catalog.return_value["scope"] = "invalid"
    with pytest.raises(RuntimeFailure) as error:
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert error.value.code == "model_default_invalid"
    runtime.store.reserve.assert_not_awaited()
    runtime.bridge.request.assert_not_awaited()


async def test_completed_replay_ignores_later_default_changes(runtime: RuntimeFixture) -> None:
    """动态目录不可影响已完成请求的收据和摘要。"""
    runtime.store.replay.return_value = (True, {"original": True})
    assert await runtime.runner.call(OWNER, "session.createAndStart", runtime.params) == {
        "original": True
    }
    runtime.models.catalog.assert_not_awaited()
    runtime.bridge.request.assert_not_awaited()
    runtime.store.reserve.assert_not_awaited()


@pytest.mark.parametrize("code", ["idempotency_conflict", "session_create_outcome_unknown"])
async def test_conflicting_or_unknown_receipt_never_resubmits(
    runtime: RuntimeFixture, code: str
) -> None:
    runtime.store.replay.side_effect = RuntimeFailure(code, "synthetic", 409)
    with pytest.raises(RuntimeFailure) as error:
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    assert error.value.code == code
    runtime.models.catalog.assert_not_awaited()
    runtime.bridge.request.assert_not_awaited()


@pytest.mark.parametrize("error", [TimeoutError, asyncio.CancelledError])
async def test_catalog_timeout_or_cancellation_never_claims_submission(
    runtime: RuntimeFixture, error: type[BaseException]
) -> None:
    runtime.bridge.request.side_effect = error
    with pytest.raises(error):
        await runtime.runner.call(OWNER, "session.createAndStart", runtime.params)
    runtime.store.reserve.assert_not_awaited()
    runtime.store.settle.assert_not_awaited()


async def test_reservation_still_arbitrates_concurrent_creation(runtime: RuntimeFixture) -> None:
    """预读与解析之后仍使用原子占位，别的请求先完成时只返回原收据。"""
    runtime.store.reserve.return_value = (False, {"concurrent": True})
    assert await runtime.runner.call(OWNER, "session.createAndStart", runtime.params) == {
        "concurrent": True
    }
    assert [call.args[0] for call in runtime.bridge.request.await_args_list] == [
        "catalog.listModels"
    ]
    runtime.store.settle.assert_not_awaited()


@pytest.mark.parametrize("state", ["missing", "completed", "conflict", "outcome_unknown"])
async def test_persistent_receipt_replay_semantics(
    monkeypatch: pytest.MonkeyPatch, state: str
) -> None:
    """直接验证持久服务的只读查询，不需要连接数据库或创建测试数据。"""
    row = (
        None
        if state == "missing"
        else RuntimeReceipt(
            owner=OWNER,
            identifier="synthetic-receipt",
            digest="other-digest" if state == "conflict" else "synthetic-digest",
            state="outcome_unknown" if state == "outcome_unknown" else "completed",
            result={"original": True},
        )
    )
    receipt = AsyncMock(return_value=row)
    monkeypatch.setattr(ProjectionDao, "receipt", receipt)
    session = AsyncMock(spec=AsyncSession)
    session.__aenter__.return_value = session
    sessions = cast(async_sessionmaker[AsyncSession], Mock(return_value=session))
    store = SqlProjectionStore(sessions)
    if state in {"conflict", "outcome_unknown"}:
        with pytest.raises(RuntimeFailure) as error:
            await store.replay(OWNER, "synthetic-receipt", "synthetic-digest")
        assert error.value.code == (
            "idempotency_conflict" if state == "conflict" else "session_create_outcome_unknown"
        )
    else:
        assert await store.replay(OWNER, "synthetic-receipt", "synthetic-digest") == (
            (False, None) if state == "missing" else (True, {"original": True})
        )
    receipt.assert_awaited_once_with(OWNER, "synthetic-receipt")
    session.commit.assert_not_awaited()

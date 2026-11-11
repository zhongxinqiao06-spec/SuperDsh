"""多模态收费边界：临时PG收据、受控供应商、取消和结果续存，不外发收费请求。"""

import asyncio
import base64
import io
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from conftest import bootstrap
from fastapi import FastAPI
from PIL import Image
from sqlalchemy import text

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import Capability, CapabilityBinding
from app.modules.models.service.model_operation_service import ModelOperationService
from app.modules.models.service.provider_transport import ProviderTransport
from toolkits.office.contracts import Artifact, InputFile
from toolkits.office.multimodal import MultimodalService


def fixture_image() -> bytes:
    """合成小图不含任何真实资料，用实际PNG解码器校验。"""
    output = io.BytesIO()
    Image.new("RGB", (8, 6), (80, 120, 150)).save(output, "PNG")
    return output.getvalue()


async def configured(
    app: FastAPI,
    client: httpx.AsyncClient,
    capability: Capability,
) -> tuple[Account, CapabilityBinding]:
    login = await bootstrap(client)
    connection = await client.post(
        "/api/admin/models/connections",
        json={
            "name": "合成多模态供应商",
            "adapter": "openai-completions",
            "baseUrl": "https://fixture.invalid/api",
            "apiKey": "synthetic-provider-key",
        },
    )
    assert connection.status_code == 200, connection.text
    config = await client.post(
        "/api/admin/models/configurations",
        json={
            "name": "合成能力",
            "connectionId": connection.json()["id"],
            "capability": capability,
            "modelId": "synthetic-model",
            "enabled": True,
            "parameters": {"size": "1024x1024"}
            if capability == "image.generate"
            else {"maxTokens": 64},
            "roleIds": [],
        },
    )
    assert config.status_code == 200, config.text
    binding = CapabilityBinding(
        configurationId=config.json()["id"], revision=1, capability=capability
    )
    return await app.state.services.identity.authenticate(str(login["accessToken"])), binding


def service(app: FastAPI, account: Account, save: object) -> MultimodalService:
    """只注入会话许可与持久成果接收器，身份、配置和操作收据使用真实领域服务。"""

    async def authorize(current: Account, session_id: str) -> object:
        if current.user_id != account.user_id or session_id != "synthetic-session":
            raise DomainError(403, "session not owned")
        return {"id": session_id}

    from typing import cast

    from toolkits.office.multimodal import SaveImage

    return MultimodalService(
        app.state.services.model_configurations,
        ModelOperationService(app.state.database, app.state.services.model_configurations.cipher),
        app.state.services.identity.get_account,
        authorize,
        cast(SaveImage, save),
    )


async def test_image_receipt_resumes_storage_without_paid_post_after_restart(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    tmp_path = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / "multimodal-images"
    tmp_path.mkdir(parents=True, exist_ok=True)
    account, binding = await configured(app, client, "image.generate")
    payload = fixture_image()
    requests: list[httpx.Request] = []

    async def receiver(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            headers={"x-request-id": "fixture-request"},
            json={
                "data": [{"b64_json": base64.b64encode(payload).decode()}],
                "usage": {"images": 1},
            },
        )

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(receiver)
    )
    fail = True

    async def save(
        current: Account, session: str, operation: str, artifact: Artifact
    ) -> dict[str, object]:
        if fail:
            raise OSError("synthetic unavailable storage")
        target = tmp_path / (operation + ".png")
        target.write_bytes(artifact.content)
        assert Image.open(target).size == (8, 6)
        return {
            "id": operation,
            "name": artifact.filename,
            "sha256": InputFile(artifact.filename, artifact.content).sha256,
            "pendingArtifact": {"objectKey": "internal-only-path"},
        }

    tools = service(app, account, save)
    draft: dict[str, object] = {
        "title": "测试配图",
        "prompt": "a safe synthetic rectangle",
    }
    prepared = await tools.prepare(account, "synthetic-session", binding, draft, [])
    assert not requests  # inspect/prepare 均不会产生费用。
    plan = prepared["document"]
    assert isinstance(plan, dict)
    with pytest.raises(OSError):
        await tools.execute(account, "synthetic-session", binding, "stable-call", plan, [])
    assert len(requests) == 1
    async with app.state.database.engine.connect() as connection:
        stored = (
            await connection.execute(text("SELECT state,receipt_ciphertext FROM model_operations"))
        ).one()
    assert stored[0] == "result-pending" and "b64_json" not in stored[1]
    fail = False
    restarted = service(app, account, save)
    result = await restarted.execute(account, "synthetic-session", binding, "stable-call", plan, [])
    assert result["fileId"] == result["operationId"] and len(requests) == 1
    again = await restarted.execute(account, "synthetic-session", binding, "stable-call", plan, [])
    assert again == result and len(requests) == 1
    with pytest.raises(DomainError) as mismatch:
        await restarted.execute(
            account,
            "synthetic-session",
            binding,
            "stable-call",
            {**plan, "prompt": "different"},
            [],
        )
    assert mismatch.value.status == 409
    operation = await client.get("/api/models/operations/" + str(result["operationId"]))
    assert operation.json()["state"] == "completed"
    assert "synthetic-provider-key" not in operation.text and "b64_json" not in operation.text
    assert "pendingArtifact" not in operation.text and "internal-only-path" not in operation.text
    assert "fileId" not in operation.json()["result"]
    assert "id" not in operation.json()["result"]


async def test_vision_incomplete_and_bad_images_never_auto_replay(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    account, binding = await configured(app, client, "vision.analyze")
    calls = 0

    async def receiver(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        assert body["max_tokens"] == 64 and body["model"] == "synthetic-model"
        return httpx.Response(
            200,
            json={"choices": [{"finish_reason": "length", "message": {"content": "partial"}}]},
        )

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(receiver)
    )

    async def unused(*args: object) -> dict[str, object]:
        raise AssertionError("vision must not save image")

    tools = service(app, account, unused)
    draft: dict[str, object] = {"title": "识图", "prompt": "describe this image"}
    with pytest.raises(DomainError):
        await tools.prepare(
            account,
            "synthetic-session",
            binding,
            draft,
            [InputFile("fake.png", b"not image")],
        )
    assert calls == 0
    images = [InputFile("fixture.png", fixture_image())]
    plan = (await tools.prepare(account, "synthetic-session", binding, draft, images))["document"]
    assert isinstance(plan, dict)
    with pytest.raises(DomainError) as incomplete:
        await tools.execute(account, "synthetic-session", binding, "vision-call", plan, images)
    assert incomplete.value.code == "vision_response_incomplete"
    with pytest.raises(DomainError) as repeated:
        await tools.execute(account, "synthetic-session", binding, "vision-call", plan, images)
    assert repeated.value.status == 409 and calls == 1


async def test_concurrent_and_cancelled_generation_keeps_unknown_receipt_without_replay(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    account, binding = await configured(app, client, "image.generate")
    waiting, release = asyncio.Event(), asyncio.Event()
    calls = 0
    closed = False

    class Pending(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            waiting.set()
            await release.wait()
            yield b"{}"

        async def aclose(self) -> None:
            nonlocal closed
            closed = True

    async def receiver(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, stream=Pending())

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(receiver)
    )

    async def unused(*args: object) -> dict[str, object]:
        raise AssertionError("cancelled generation must not publish")

    tools = service(app, account, unused)
    plan = (
        await tools.prepare(
            account,
            "synthetic-session",
            binding,
            {"title": "cancel", "prompt": "wait"},
            [],
        )
    )["document"]
    assert isinstance(plan, dict)
    task = asyncio.create_task(
        tools.execute(account, "synthetic-session", binding, "cancel-call", plan, [])
    )
    try:
        await asyncio.wait_for(waiting.wait(), 3)
        with pytest.raises(DomainError) as concurrent:
            await tools.execute(account, "synthetic-session", binding, "cancel-call", plan, [])
        assert concurrent.value.status == 409
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed and calls == 1
        with pytest.raises(DomainError):
            await service(app, account, unused).execute(
                account, "synthetic-session", binding, "cancel-call", plan, []
            )
        assert calls == 1
        async with app.state.database.engine.connect() as connection:
            assert (
                await connection.scalar(text("SELECT state FROM model_operations"))
                == "cancel-requested"
            )
    finally:
        release.set()
        if not task.done():
            task.cancel()

"""参考资料公共能力：结构化引用、跨产品模型授权与收费请求幂等。"""

import io
import json
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image
from sqlalchemy import text
from test_office_multimodal_phase_two import configured, fixture_image
from test_reference_stream import FixtureStream, sse, stream_events

from app.infrastructure.errors import DomainError
from app.modules.models.entity.vo.model_vo import CapabilityDefaultInput
from app.modules.models.service.capabilities import validate_parameters
from app.modules.models.service.model_operation_service import ModelOperationService
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.reference_analysis_service import ReferenceAnalysisService
from app.modules.models.service.reference_protocol import (
    encode_images,
    research_answer,
    search_request,
    vision_request,
)
from toolkits.office.multimodal_protocol import vision_answer


def search_response(annotations: list[dict[str, object]]) -> dict[str, object]:
    """只有供应商协议字段中的引用才作为资料来源。"""
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "海南有海滨景观。正文网址 https://invented.invalid 不是证据。",
                        "annotations": annotations,
                    }
                ],
            }
        ],
    }


def test_research_requires_structured_sources_and_filters_unsafe_urls() -> None:
    response = search_response(
        [
            {"type": "url_citation", "url": "https://example.org/hainan", "title": "海南资料"},
            {
                "type": "url_citation",
                "url_citation": {"url": "https://example.org/hainan", "title": "海南资料"},
            },
            {"type": "url_citation", "url": "javascript:alert(1)"},
            {"type": "url_citation", "url": "https://user:secret@example.org"},
            {"type": "note", "url": "https://other.invalid"},
        ]
    )
    assert research_answer(response)["sources"] == [
        {"title": "海南资料", "url": "https://example.org/hainan"}
    ]
    with pytest.raises(DomainError) as missing:
        research_answer(search_response([]))
    assert missing.value.code == "research_sources_missing"
    with pytest.raises(DomainError) as incomplete:
        research_answer({**response, "status": "incomplete"})
    assert incomplete.value.code == "vision_response_incomplete"


@pytest.mark.parametrize(
    "adapter,protocol,endpoint",
    [
        ("openai-completions", "responses", "/responses"),
        ("openai-completions", "chat-completions", "/chat/completions"),
        ("volcengine-ark", "responses", "/responses"),
        ("volcengine-ark", "chat-completions", "/chat/completions"),
    ],
)
def test_search_protocol_is_configuration_driven(
    adapter: str, protocol: str, endpoint: str
) -> None:
    parameters = validate_parameters(
        adapter, "web.search", "custom-research-model", {"protocol": protocol}
    )
    path, body = search_request(adapter, "custom-research-model", parameters, "海南旅行")
    assert path == endpoint and body["model"] == "custom-research-model"
    if adapter == "openai-completions" and protocol == "chat-completions":
        assert body["enable_search"] is True
        assert body["search_options"] == {"forced_search": True}
        assert "enable_source" not in json.dumps(body)
    else:
        assert body["tools"] == [{"type": "web_search"}]


@pytest.mark.parametrize(
    "parameters", [{"protocol": []}, {"protocol": "invented"}, {"maxTokens": True}, {"extra": 1}]
)
def test_search_invalid_configuration_is_rejected(parameters: dict[str, object]) -> None:
    with pytest.raises(DomainError):
        validate_parameters("openai-completions", "web.search", "configured-model", parameters)


def test_shared_vision_protocol_checks_images_and_rejects_incomplete_text() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 6), "orange").save(buffer, "PNG")
    encoded = encode_images([(buffer.getvalue(), "image/png")], 1)
    path, body = vision_request(
        "volcengine-ark", "configured-model", {"thinking": "disabled"}, "识别形象", encoded
    )
    assert path == "/responses" and body["thinking"] == {"type": "disabled"}
    assert (
        vision_answer({"choices": [{"finish_reason": "stop", "message": {"content": "圆形角色"}}]})
        == "圆形角色"
    )
    with pytest.raises(DomainError):
        encode_images([(buffer.getvalue(), "image/jpeg")], 1)
    with pytest.raises(DomainError):
        encode_images([(b"not an image", "image/png")], 1)
    with pytest.raises(DomainError):
        vision_answer({"choices": [{"finish_reason": "length", "message": {"content": "partial"}}]})


async def test_research_paid_request_is_idempotent_and_missing_sources_never_replay(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    account, binding = await configured(app, client, "web.search")
    requests: list[httpx.Request] = []
    missing = False

    async def receiver(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        assert body["tools"] == [{"type": "web_search"}]
        return httpx.Response(
            200,
            json=search_response(
                []
                if missing
                else [
                    {
                        "type": "url_citation",
                        "title": "公开来源",
                        "url": "https://example.org/hainan",
                    }
                ]
            ),
        )

    configurations = app.state.services.model_configurations
    configurations.transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    service = ReferenceAnalysisService(
        configurations,
        ModelOperationService(app.state.database, configurations.cipher),
        app.state.services.identity,
    )
    # 没有默认选择时不擅自选另一供应商；只读检查不产生模型请求。
    assert (await service.inspect(account, "office"))["research"] == {
        "available": False,
        "binding": None,
        "name": "",
        "maxImages": 0,
        "reason": "请在当前产品设置此能力的默认模型",
    }
    await configurations.set_default(
        account,
        "web.search",
        CapabilityDefaultInput(configurationId=binding.configurationId, revision=0),
    )
    assert (await service.inspect(account, "office"))["research"] == {
        "available": True,
        "binding": binding.model_dump(),
        "name": "合成能力",
        "maxImages": 0,
    }
    assert not requests
    first = await service.search(
        account, "office", "owned-reference-scope", "first", binding, "海南旅行"
    )
    again = await service.search(
        account, "office", "owned-reference-scope", "first", binding, "海南旅行"
    )
    assert first == again and len(requests) == 1
    with pytest.raises(DomainError) as changed:
        await service.search(
            account, "office", "owned-reference-scope", "first", binding, "不同内容"
        )
    assert changed.value.status == 409 and len(requests) == 1
    missing = True
    with pytest.raises(DomainError) as no_source:
        await service.search(
            account, "office", "owned-reference-scope", "no-source", binding, "海南旅行"
        )
    assert no_source.value.code == "research_sources_missing"
    with pytest.raises(DomainError) as no_replay:
        await service.search(
            account, "office", "owned-reference-scope", "no-source", binding, "海南旅行"
        )
    assert no_replay.value.code == "provider_operation_pending" and len(requests) == 2


async def test_research_unknown_acceptance_never_resubmits(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    account, binding = await configured(app, client, "web.search")
    calls = 0

    async def receiver(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    configurations = app.state.services.model_configurations
    configurations.transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    service = ReferenceAnalysisService(
        configurations,
        ModelOperationService(app.state.database, configurations.cipher),
        app.state.services.identity,
    )
    with pytest.raises(DomainError) as timeout:
        await service.search(
            account, "office", "owned-reference-scope", "unknown", binding, "海南旅行"
        )
    assert timeout.value.code == "provider_operation_pending"
    assert "等待联网结果超时，状态待核对" in timeout.value.detail
    with pytest.raises(DomainError) as refused:
        await service.search(
            account, "office", "owned-reference-scope", "unknown", binding, "海南旅行"
        )
    assert refused.value.code == "provider_operation_pending" and calls == 1


async def test_vision_same_reference_reuses_completed_result_with_new_request_key(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    account, binding = await configured(app, client, "vision.analyze")
    calls = 0

    async def receiver(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={"choices": [{"finish_reason": "stop", "message": {"content": "合成橙色角色"}}]},
        )

    configurations = app.state.services.model_configurations
    configurations.transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    operations = ModelOperationService(app.state.database, configurations.cipher)
    service = ReferenceAnalysisService(configurations, operations, app.state.services.identity)
    images = [(fixture_image(), "image/png")]
    first = await service.analyze(
        account, "office", "own-project", "before-research-error", binding, "识别角色", images
    )
    reused = await service.analyze(
        account, "office", "own-project", "explicit-retry", binding, "识别角色", images
    )
    assert first == reused and calls == 1
    async with app.state.database.engine.connect() as connection:
        request_hash = str(
            await connection.scalar(
                text("SELECT request_hash FROM model_operations WHERE id=:id"),
                {"id": first["operationId"]},
            )
        )
    assert await operations.completed_result(account, "own-project", binding, request_hash) == first
    assert (
        await operations.completed_result(
            replace(account, user_id="another-user"), "own-project", binding, request_hash
        )
        is None
    )
    assert (
        await operations.completed_result(account, "other-project", binding, request_hash) is None
    )
    assert (
        await operations.completed_result(
            account, "own-project", binding.model_copy(update={"revision": 2}), request_hash
        )
        is None
    )
    assert await operations.completed_result(account, "own-project", binding, "0" * 64) is None
    # 即使来自缓存，新操作号也有冻结摘要；不能随后用同号提交不同输入。
    with pytest.raises(DomainError) as changed:
        await service.analyze(
            account, "office", "own-project", "explicit-retry", binding, "不同要求", images
        )
    assert changed.value.status == 409 and calls == 1
    await service.analyze(
        account, "office", "other-project", "different-scope", binding, "识别角色", images
    )
    assert calls == 2


async def test_research_stream_receipt_and_unknown_disconnect_keep_operation_boundary(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    account, binding = await configured(app, client, "web.search")
    calls, truncate = 0, False

    async def receiver(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert json.loads(request.content)["stream"] is True
        assert request.extensions["timeout"]["read"] == 180
        events = stream_events()
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=FixtureStream(sse(events[:-1] if truncate else events)),
        )

    configurations = app.state.services.model_configurations
    configurations.transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    service = ReferenceAnalysisService(
        configurations,
        ModelOperationService(app.state.database, configurations.cipher),
        app.state.services.identity,
    )
    first = await service.search(
        account, "office", "own-project", "first-search", binding, "海南旅行"
    )
    fresh = await service.search(
        account, "office", "own-project", "new-search", binding, "海南旅行"
    )
    assert first["text"] == fresh["text"] and calls == 2  # 联网查询不跨操作号缓存。
    truncate = True
    with pytest.raises(DomainError) as disconnected:
        await service.search(account, "office", "own-project", "disconnected", binding, "海南旅行")
    assert disconnected.value.code == "research_stream_incomplete"
    async with app.state.database.engine.connect() as connection:
        state, response_id = (
            await connection.execute(
                text(
                    "SELECT state,request_id FROM model_operations WHERE state='submission-unknown'"
                )
            )
        ).one()
    assert state == "submission-unknown" and response_id == "response-fixture"
    with pytest.raises(DomainError) as refused:
        await service.search(account, "office", "own-project", "disconnected", binding, "海南旅行")
    assert refused.value.code == "provider_operation_pending" and calls == 3

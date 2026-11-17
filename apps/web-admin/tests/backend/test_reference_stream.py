"""受控 SSE 覆盖跨块中文、完整收据、未知断流与有界超时，不调用外部模型。"""

import json
from collections.abc import AsyncIterator

import httpx
import pytest

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport
from app.modules.models.service.reference_protocol import research_answer
from app.modules.models.service.reference_response import reference_response


class FixtureStream(httpx.AsyncByteStream):
    """故意在 UTF-8 和 SSE 字段中间断块。"""

    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for start in range(0, len(self.content), 7):
            yield self.content[start : start + 7]


def sse(events: list[dict[str, object]]) -> bytes:
    """注释心跳与 CRLF 都不是业务正文。"""
    return b": keepalive\r\n\r\n" + b"".join(
        b"event: "
        + str(item["type"]).encode()
        + b"\r\ndata: "
        + json.dumps(item, ensure_ascii=False).encode()
        + b"\r\n\r\n"
        for item in events
    )


def stream_events() -> list[dict[str, object]]:
    """完成快照省略 output 时，只能使用已完成的输出项补齐。"""
    return [
        {
            "type": "response.created",
            "sequence_number": 0,
            "response": {"id": "response-fixture", "status": "queued"},
        },
        {
            "type": "response.output_item.done",
            "sequence_number": 2,
            "output_index": 0,
            "item": {
                "type": "web_search_call",
                "status": "completed",
                "action": {
                    "type": "search",
                    "sources": [{"type": "url", "url": "https://example.org/hainan"}],
                },
            },
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 3,
            "delta": "不能把未完成片段作为回答",
        },
        {
            "type": "response.output_item.done",
            "sequence_number": 4,
            "output_index": 1,
            "item": {
                "type": "message",
                "status": "completed",
                "content": [{"type": "output_text", "text": "海南旅行资料", "annotations": []}],
            },
        },
        {
            "type": "response.completed",
            "sequence_number": 5,
            "response": {
                "id": "response-fixture",
                "status": "completed",
                "usage": {"output_tokens": 20},
            },
        },
    ]


async def test_sse_reconstructs_only_completed_items_and_records_identity() -> None:
    identifiers: list[str] = []

    async def record(value: str) -> None:
        identifiers.append(value)

    response = httpx.Response(
        200,
        headers={"content-type": "text/event-stream; charset=utf-8"},
        stream=FixtureStream(sse(stream_events())),
    )
    result = await reference_response(response, streaming=True, record_response_id=record)
    assert identifiers == ["response-fixture"]
    assert research_answer(result) == {
        "text": "海南旅行资料",
        "sources": [{"title": "example.org", "url": "https://example.org/hainan"}],
    }
    assert result["usage"] == {"output_tokens": 20}


@pytest.mark.parametrize("case", ["truncated", "done-only", "reordered", "changed-identity"])
async def test_sse_without_consistent_completion_never_publishes(case: str) -> None:
    events = stream_events()
    if case in {"truncated", "done-only"}:
        events.pop()
    elif case == "reordered":
        events[2]["sequence_number"] = 1
    else:
        events[-1]["response"] = {"id": "different", "status": "completed"}
    raw = sse(events) + (b"data: [DONE]\n\n" if case == "done-only" else b"")

    async def record(value: str) -> None:
        assert value == "response-fixture"

    response = httpx.Response(
        200, headers={"content-type": "text/event-stream"}, stream=FixtureStream(raw)
    )
    with pytest.raises(DomainError) as failed:
        await reference_response(response, streaming=True, record_response_id=record)
    assert failed.value.code == "research_stream_incomplete"


async def test_transport_allows_bounded_read_override_without_relaxing_connect() -> None:
    observed: list[object] = []

    async def receiver(request: httpx.Request) -> httpx.Response:
        observed.append(request.extensions["timeout"])
        return httpx.Response(200, json={"ok": True})

    transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    async with transport.open_stream(
        "GET", "https://fixture.invalid", {}, read_timeout=180
    ) as response:
        await response.aread()
    assert observed == [{"connect": 10, "read": 180, "write": 60, "pool": 60}]
    assert await transport.request("POST", "https://fixture.invalid", {}, {}, read_timeout=240) == {
        "ok": True
    }
    assert observed[-1] == {"connect": 10, "read": 240, "write": 60, "pool": 60}
    with pytest.raises(DomainError):
        async with transport.open_stream("GET", "https://fixture.invalid", {}, read_timeout=0):
            raise AssertionError("invalid timeout must not open transport")


@pytest.mark.parametrize(
    "error_type,code",
    [
        (httpx.ReadTimeout, "provider_read_timeout"),
        (httpx.ConnectTimeout, "provider_connect_timeout"),
    ],
)
async def test_transport_distinguishes_result_wait_from_connection_failure(
    error_type: type[httpx.TimeoutException],
    code: str,
) -> None:
    async def receiver(request: httpx.Request) -> httpx.Response:
        raise error_type("synthetic timeout", request=request)

    transport = ProviderTransport(transport=httpx.MockTransport(receiver))
    with pytest.raises(DomainError) as failed:
        async with transport.open_stream("POST", "https://fixture.invalid", {}, {"stream": True}):
            raise AssertionError("timed out request cannot succeed")
    assert failed.value.status == 504 and failed.value.code == code

"""参考分析供应商响应读取：有界 SSE、请求标识留存和完整终止事件校验。"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable

import httpx

from app.infrastructure.errors import DomainError
from app.modules.models.service.reference_protocol import object_value

RecordResponseId = Callable[[str], Awaitable[None]]


async def _events(response: httpx.Response) -> AsyncIterator[dict[str, object]]:
    # 以字节拆行，避免 UTF-8 跨网络分块丢字；总量和单事件均有界，心跳也计入总量。
    buffer, total, event_size = bytearray(), 0, 0
    lines: list[bytes] = []
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > 16 * 1024 * 1024:
            raise DomainError(502, "联网响应超过处理上限")
        buffer.extend(chunk)
        while b"\n" in buffer:
            end = buffer.index(b"\n")
            line = bytes(buffer[:end]).rstrip(b"\r")
            del buffer[: end + 1]
            if not line:
                if lines:
                    raw = b"\n".join(lines)
                    lines, event_size = [], 0
                    if raw == b"[DONE]":
                        return
                    try:
                        value = json.loads(raw)
                    except (ValueError, UnicodeError) as error:
                        raise DomainError(502, "联网流式响应格式无效") from error
                    if not isinstance(value, dict):
                        raise DomainError(502, "联网流式响应格式无效")
                    yield value
            elif line.startswith(b"data:"):
                value = line[5:].lstrip(b" ")
                event_size += len(value)
                if event_size > 4 * 1024 * 1024:
                    raise DomainError(502, "联网单次响应事件过大")
                lines.append(value)
        if len(buffer) > 4 * 1024 * 1024:
            raise DomainError(502, "联网单次响应行过大")
    # 未收到事件分隔符也不把截断的尾包当完整结果；上层报告流未完成。


async def reference_response(
    response: httpx.Response,
    *,
    streaming: bool,
    record_response_id: RecordResponseId,
) -> dict[str, object]:
    """只有完整 JSON 或 response.completed 才可成为收据，断流不能发布部分正文。"""
    if "text/event-stream" not in response.headers.get("content-type", "").lower():
        raw = bytearray()
        async for chunk in response.aiter_bytes():
            raw.extend(chunk)
            if len(raw) > 4 * 1024 * 1024:
                raise DomainError(502, "参考资料分析响应超过处理上限")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise DomainError(502, "供应商返回的数据格式无效") from error
        if not isinstance(value, dict):
            raise DomainError(502, "供应商返回的数据格式无效")
        return value
    if not streaming:
        raise DomainError(502, "供应商返回了未声明的流式响应")
    response_id = ""
    previous_sequence: int | None = None
    previous_event: dict[str, object] | None = None
    completed_items: dict[int, dict[str, object]] = {}
    async for event in _events(response):
        sequence = event.get("sequence_number")
        if isinstance(sequence, int) and not isinstance(sequence, bool):
            if previous_sequence is not None and sequence <= previous_sequence:
                if sequence == previous_sequence and event == previous_event:
                    continue
                raise DomainError(
                    502, "联网响应事件顺序异常；未自动重试", "research_stream_incomplete"
                )
            previous_sequence, previous_event = sequence, event
        kind = event.get("type")
        value = object_value(event.get("response"))
        identity = value.get("id")
        if isinstance(identity, str) and 0 < len(identity) <= 200:
            if response_id and response_id != identity:
                raise DomainError(
                    502, "联网响应标识不一致；未自动重试", "research_stream_incomplete"
                )
            if not response_id:
                response_id = identity
                await record_response_id(identity)
        if kind == "response.output_item.done":
            index, item = event.get("output_index"), object_value(event.get("item"))
            if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < 1000:
                completed_items[index] = item
        if kind in {"response.failed", "response.incomplete", "error"}:
            return {**value, "status": "incomplete" if kind == "response.incomplete" else "failed"}
        if kind == "response.completed":
            if value.get("status") != "completed":
                raise DomainError(502, "联网响应缺少完成状态", "research_stream_incomplete")
            # 兼容完成事件只带 usage 的供应商；只用已收到 done 的完整项，不拼推理或未完成 delta。
            if not value.get("output") and completed_items:
                value = {
                    **value,
                    "output": [completed_items[index] for index in sorted(completed_items)],
                }
            return value
    raise DomainError(
        502,
        "联网连接已结束，但未收到完成结果；请核对请求记录，未自动重试",
        "research_stream_incomplete",
    )

"""真实 DSH 集成测试的本地受控模型；不能将它标为真实外部模型覆盖。"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator

from app.integrations.dsh.protocol import Fields, fields


class ControlledModels:
    """以真实 SSE 流驱动固定引擎，允许验证取消和工具回调。"""

    def __init__(self) -> None:
        self.scope = hashlib.sha256(b"controlled-dsh-validation").hexdigest()
        self.calls = 0
        self.cancelled = 0
        self.stream_cancelled = asyncio.Event()
        self.started = asyncio.Event()
        self.received_tools: list[str] = []

    async def catalog(self, owner: str) -> Fields:
        """仅有无费用合成模型，不读取真实账号或供应商密钥。"""
        return {
            "scope": self.scope,
            "providers": [
                {
                    "providerId": "controlled",
                    "name": "受控测试模型",
                    "protocol": "openai-completions",
                    "models": [
                        {
                            "modelId": "controlled",
                            "name": "受控测试模型",
                            "contextWindow": 32768,
                            "maxTokens": 1024,
                        }
                    ],
                }
            ],
        }

    async def stream(self, owner: str, path: str, body: Fields) -> AsyncIterator[bytes]:
        """标准流响应，挂起输入只能由原生逐会话取消终止。"""
        self.calls += 1
        self.started.set()
        messages = body.get("messages", [])
        text = json.dumps(messages, ensure_ascii=False)
        tools = body.get("tools", [])
        if isinstance(tools, list):
            self.received_tools.extend(
                str(fields(fields(tool).get("function")).get("name")) for tool in tools
            )
        yield self._chunk({"role": "assistant"})
        if "MODEL_CANCEL_PROBE" in text:
            yield self._chunk({"content": "正在等待取消"})
            try:
                while True:
                    await asyncio.sleep(1)
                    yield b": keepalive\n\n"
            finally:
                self.cancelled += 1
                self.stream_cancelled.set()
        elif (
            "TOOL_PROBE" in text or "TOOL_CANCEL_PROBE" in text or "CONFIRM_PROBE" in text
        ) and '"role": "tool"' not in text:
            yield self._chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-controlled",
                            "type": "function",
                            "function": {
                                "name": "validation_probe",
                                "arguments": json.dumps(
                                    {
                                        "value": "cancel"
                                        if "TOOL_CANCEL_PROBE" in text
                                        else "confirmation"
                                        if "CONFIRM_PROBE" in text
                                        else "synthetic"
                                    }
                                ),
                            },
                        }
                    ]
                }
            )
            yield self._chunk({}, "tool_calls")
        else:
            yield self._chunk({"content": "受控模型已完成"})
            yield self._chunk({}, "stop")
        yield b"data: [DONE]\n\n"

    def _chunk(self, delta: Fields, finish: str | None = None) -> bytes:
        value = {
            "id": "controlled-response",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "controlled",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        return ("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode()

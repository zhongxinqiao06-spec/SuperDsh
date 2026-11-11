"""旧入口响应包装只在接入层执行，业务服务和 WebSocket 不感知协议版本。"""

import json
from datetime import UTC, datetime

from starlette.types import Message, Send


class CompatibilityResponse:
    """有界缓冲成功 JSON；错误状态、流式内容和响应头保持原协议语义。"""

    def __init__(
        self,
        send: Send,
        envelope: str,
        state: dict[str, object] | None = None,
        source: str | None = None,
    ) -> None:
        self.send = send
        self.envelope = envelope
        self.state, self.source = state, source
        self.start: Message | None = None
        self.body = bytearray()
        self.failed = False

    async def __call__(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = dict(message.get("headers", []))
            if (
                200 <= message["status"] < 300
                and headers.get(b"content-type", b"").split(b";", 1)[0] == b"application/json"
                and b"content-encoding" not in headers
            ):
                self.start = dict(message)
            else:
                await self.send(message)
            return
        if message["type"] != "http.response.body" or self.start is None:
            await self.send(message)
            return
        if len(self.body) + len(message.get("body", b"")) > 8 * 1024 * 1024:
            self.body.clear()
            self.failed = True
        elif not self.failed:
            self.body.extend(message.get("body", b""))
        if message.get("more_body", False):
            return
        try:
            if self.failed:
                raise ValueError("response limit")
            result = json.loads(self.body)
            if self.source == "protocol":
                # 来源只能由受信handler写入请求状态；缺失时失败，不能猜测解包并丢设备字段。
                if self.state is None or not isinstance(self.state.get("protocol_result"), dict):
                    raise ValueError("missing protocol response")
                result = self.state["protocol_result"]
            if self.envelope == "result":
                value = {"ok": True, "result": result, "error": None}
            else:
                if not isinstance(result, dict):
                    raise ValueError("expected terminal object")
                value = {
                    self.envelope: result.get(self.envelope)
                    or ([] if self.envelope == "terminals" else result),
                    "serverTime": datetime.now(UTC).isoformat(),
                }
            payload = json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
            if len(payload) > 8 * 1024 * 1024:
                raise ValueError("response limit")
        except (ValueError, UnicodeError):
            self.start["status"] = 502
            payload = b'{"detail":"invalid compatibility response"}'
        self.start["headers"] = [
            (key, value) for key, value in self.start.get("headers", []) if key != b"content-length"
        ] + [(b"content-length", str(len(payload)).encode())]
        await self.send(self.start)
        await self.send({"type": "http.response.body", "body": payload})
        self.body.clear()

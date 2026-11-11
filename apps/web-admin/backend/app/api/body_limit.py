"""读取 ASGI 流时执行累计字节上限，不信任 Content-Length。"""

import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BodyLimitMiddleware:
    """基础 JSON API 在解码前有界收集；未来文件流应采用专用限额通道。"""

    def __init__(self, app: ASGIApp, limit: int = 8 * 1024 * 1024) -> None:
        self.app, self.limit = app, limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        # 兼容中间件先解析到规范入口；增加上传限额不会放宽其他JSON接口。
        limit = self.limit
        budgets = (
            ("POST", r"/api/admin/extensions/install", 24),
            ("POST", r"/api/admin/skills/import", 17),
            ("POST", r"/api/sessions/[^/]+/attachments(?:/[^/]+)?", 64),
        )
        for method, pattern, mebibytes in budgets:
            if scope["method"] == method and re.fullmatch(pattern, scope["path"].rstrip("/")):
                limit = mebibytes * 1024 * 1024
                break
        try:
            declared = int(dict(scope.get("headers", [])).get(b"content-length", b"0"))
        except ValueError:
            await JSONResponse({"detail": "invalid content length"}, status_code=400)(
                scope, receive, send
            )
            return
        if declared < 0 or declared > limit:
            await JSONResponse({"detail": "request body too large"}, status_code=413)(
                scope, receive, send
            )
            return
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > limit:
                await JSONResponse({"detail": "request body too large"}, status_code=413)(
                    scope, receive, send
                )
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        supplied = False

        async def bounded_receive() -> Message:
            nonlocal supplied
            if not supplied:
                supplied = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)

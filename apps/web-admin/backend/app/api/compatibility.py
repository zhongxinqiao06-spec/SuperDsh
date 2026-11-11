"""按集中清单改写 ASGI 入口；不复制 handler，不信任客户端模式头。"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi.routing import iter_route_contexts
from starlette.routing import BaseRoute, WebSocketRoute
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.compatibility_response import CompatibilityResponse

PARAMETER = re.compile(r"\{([A-Za-z_]\w*)(?::(path))?\}")


def compile_path(path: str) -> tuple[re.Pattern[str], dict[str, str], tuple[int, ...]]:
    """只支持单段和尾部多段参数，禁止把任意正则注入入口配置。"""
    if not path.startswith("/") or any(value in path for value in ("?", "#", "\\")):
        raise ValueError("兼容路径格式无效")
    parameters: dict[str, str] = {}
    parts: list[str] = []
    offset = 0
    for match in PARAMETER.finditer(path):
        name, converter = match.group(1), match.group(2) or "str"
        if name in parameters or (converter == "path" and match.end() != len(path)):
            raise ValueError("兼容路径参数重复或多段参数不是末段")
        parameters[name] = converter
        parts.extend(
            (
                re.escape(path[offset : match.start()]),
                f"(?P<{name}>" + (".+" if converter == "path" else "[^/]+") + ")",
            )
        )
        offset = match.end()
    parts.append(re.escape(path[offset:]))
    literal = PARAMETER.sub("", path)
    if "{" in literal or "}" in literal:
        raise ValueError("兼容路径参数格式无效")
    # 静态段优先于参数；多段尾参数优先级最低，避免声明顺序改变业务入口。
    priority = tuple(
        0 if ":path}" in part else 1 if "{" in part else 2
        for part in path.rstrip("/").split("/")[1:]
    )
    return re.compile("^" + "".join(parts) + "/?$"), parameters, priority


def substitute(template: str, values: dict[str, str]) -> str:
    """参数按原始百分号编码替换一次，不把 :path 当 Python 格式化说明。"""
    return PARAMETER.sub(lambda match: values[match.group(1)], template)


@dataclass(frozen=True)
class CompatibilityRoute:
    """编译结果保留双向模板及传输类型，响应链接复用相同参数规则。"""

    transport: str
    method: str
    legacy: str
    canonical: str
    pattern: re.Pattern[str]
    reverse: re.Pattern[str]
    priority: tuple[int, ...]
    response_envelope: str | None
    response_source: str | None = None


class CompatibilityCatalog:
    """编译精确方法/路径/传输映射，并为响应生成入口相关路径。"""

    def __init__(self, path: Path) -> None:
        self.data = json.loads(path.read_text(encoding="utf-8"))
        self.routes: list[CompatibilityRoute] = []
        seen: set[tuple[str, str, str]] = set()
        for route in self.data["routes"]:
            source, target = route["legacy"], route["canonical"]
            pattern, parameters, priority = compile_path(source)
            reverse, target_parameters, _ = compile_path(target)
            if parameters != target_parameters:
                raise ValueError("兼容路径参数不匹配")
            transport, method = route["transport"], route["method"]
            envelope = route.get("responseEnvelope")
            response_source = route.get("responseSource")
            if envelope not in {None, "result", "terminal", "terminals"} or (
                envelope and transport != "http"
            ):
                raise ValueError("兼容响应封装类型无效")
            if response_source not in {None, "protocol"} or (response_source and not envelope):
                raise ValueError("兼容响应来源无效")
            if (
                transport not in {"http", "websocket"}
                or ((transport == "websocket") != (method == "WEBSOCKET"))
                or method
                not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WEBSOCKET"}
            ):
                raise ValueError("兼容入口传输或方法无效")
            normalized = PARAMETER.sub(
                lambda match: "{:path}" if match.group(2) else "{}", source
            ).rstrip("/")
            key = (transport, method, normalized)
            if key in seen:
                raise ValueError("兼容入口重复")
            seen.add(key)
            self.routes.append(
                CompatibilityRoute(
                    transport,
                    method,
                    source,
                    target,
                    pattern,
                    reverse,
                    priority,
                    envelope,
                    response_source,
                )
            )
        self.routes.sort(key=lambda route: route.priority, reverse=True)
        # 相同优先级的交叉参数模板可能同时命中，必须在启动时消除歧义。
        for index, left in enumerate(self.routes):
            for right in self.routes[index + 1 :]:
                if (left.transport, left.method, left.priority) != (
                    right.transport,
                    right.method,
                    right.priority,
                ):
                    continue
                a, b = left.legacy.split("/"), right.legacy.split("/")
                if len(a) == len(b) and all(
                    x == y or PARAMETER.fullmatch(x) or PARAMETER.fullmatch(y)
                    for x, y in zip(a, b, strict=True)
                ):
                    raise ValueError(f"兼容入口存在路径歧义: {left.legacy} <> {right.legacy}")

    def validate_targets(self, routes: Sequence[BaseRoute] | dict[str, object]) -> None:
        """同时验证 HTTP 与 WS 的真实路由，包含 FastAPI 嵌套路由上下文。"""
        targets: list[tuple[str, str, re.Pattern[str]]] = []
        if isinstance(routes, dict):
            for path, methods in routes.items():
                if isinstance(methods, dict):
                    targets.extend(
                        ("http", method.upper(), compile_path(path)[0]) for method in methods
                    )
        else:
            for context in iter_route_contexts(routes):
                if context.path is None:
                    continue
                pattern = compile_path(context.path)[0]
                if isinstance(context.original_route, WebSocketRoute):
                    targets.append(("websocket", "WEBSOCKET", pattern))
                else:
                    targets.extend(("http", method, pattern) for method in context.methods or ())
        for route in self.routes:
            if not any(
                (transport, method) == (route.transport, route.method)
                and pattern.fullmatch(route.canonical)
                for transport, method, pattern in targets
            ):
                raise ValueError(f"兼容映射目标未注册: {route.method} {route.canonical}")

    def cookie(self, scope: Scope, name: str) -> tuple[str, str]:
        """Cookie 历史 Path 仅从集中配置读取，登出也使用同一来源。"""
        definition = self.data["cookies"][name]
        return str(definition["name"]), str(
            definition["legacyPath"] if scope.get("compatibility") else definition["canonicalPath"]
        )

    def outward(self, scope: Scope, canonical: str, method: str = "GET") -> str:
        """只映射本服务已登记路径，保留动态参数和查询；外部 URI 不改写。"""
        if not scope.get("compatibility"):
            return canonical
        path, separator, query = canonical.partition("?")
        for route in self.routes:
            match = route.reverse.fullmatch(path)
            if route.method == method and match:
                return substitute(route.legacy, match.groupdict()) + separator + query
        return canonical


class CompatibilityMiddleware:
    """路由匹配前使用原始路径；查询、WS 子协议和票据内容原样交给同一 handler。"""

    def __init__(self, app: ASGIApp, catalog: CompatibilityCatalog) -> None:
        self.app, self.catalog = app, catalog

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            scope = dict(scope)
            scope.pop("compatibility", None)
            transport, method = scope["type"], scope.get("method", "WEBSOCKET")
            raw = scope.get("raw_path", quote(scope["path"], safe="/").encode()).decode("ascii")
            for route in self.catalog.routes:
                if (transport, method) != (route.transport, route.method):
                    continue
                match = route.pattern.fullmatch(raw)
                if match:
                    rewritten = substitute(route.canonical, match.groupdict())
                    scope["compatibility"] = {"original_path": raw}
                    scope["raw_path"], scope["path"] = rewritten.encode("ascii"), unquote(rewritten)
                    if route.response_envelope:
                        send = CompatibilityResponse(
                            send,
                            route.response_envelope,
                            scope.setdefault("state", {}),
                            route.response_source,
                        )
                    break
        await self.app(scope, receive, send)

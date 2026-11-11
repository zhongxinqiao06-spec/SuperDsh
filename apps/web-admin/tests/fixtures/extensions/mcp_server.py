"""受控MCP接收器，同时覆盖真实stdio和StreamableHTTP协议，不访问外部系统。"""

import sys
from typing import Any

import uvicorn
from mcp.server.mcpserver import MCPServer
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

server: MCPServer[Any] = MCPServer("synthetic-receiver")


def echo(value: str) -> dict[str, str]:
    """仅返回合成输入，用于检查发现和结构化结果。"""
    if value == "fail":
        raise ValueError("synthetic-private-error-must-not-leak")
    return {"echo": value}


def changed(value: int) -> dict[str, str]:
    """相同工具名的输入Schema变化必须使旧授权失败。"""
    return {"echo": str(value)}


def mutate() -> dict[str, str]:
    """只有测试接收器暴露的变更入口。"""
    server.remove_tool("echo")
    server.add_tool(changed, name="echo")
    return {"changed": "yes"}


server.add_tool(echo, name="echo")
server.add_tool(mutate, name="mutate")

if __name__ == "__main__":
    if len(sys.argv) == 1:
        server.run("stdio")
    else:
        app = server.streamable_http_app(json_response=True, stateless_http=True)

        async def control(request: Request) -> JSONResponse:
            return JSONResponse(mutate())

        async def ready(request: Request) -> JSONResponse:
            return JSONResponse({"ok": True})

        app.routes.extend([Route("/control", control, methods=["POST"]), Route("/ready", ready)])
        uvicorn.run(
            app, host="127.0.0.1", port=int(sys.argv[1]), log_level="error", access_log=False
        )

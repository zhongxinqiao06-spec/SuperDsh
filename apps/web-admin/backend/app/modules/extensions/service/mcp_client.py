"""MCP 发现和调用保留远端Schema快照，变化后必须重新授权。"""

import asyncio
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx2
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import PaginatedRequestParams

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.mcp_transport import EndpointTransport
from app.modules.extensions.service.process import tool_environment
from app.modules.extensions.service.validation import digest, tool_descriptor


class McpClient:
    """HTTP与stdio使用同一工具目录校验，不开放采样或文件系统roots。"""

    def __init__(self, allowed_origins: str = "") -> None:
        self.allowed_origins = allowed_origins

    @asynccontextmanager
    async def connect(
        self,
        endpoint: str | None = None,
        token: str | None = None,
        command: list[str] | None = None,
        directory: Path | None = None,
    ) -> AsyncIterator[ClientSession]:
        """超时和取消关闭会话及子进程，远端错误正文不进入平台响应。"""
        try:
            async with asyncio.timeout(600):
                if endpoint:
                    async with httpx2.AsyncClient(
                        transport=EndpointTransport(endpoint, self.allowed_origins),
                        timeout=30,
                        trust_env=False,
                        headers={"Authorization": "Bearer " + token} if token else {},
                    ) as client:
                        async with streamable_http_client(
                            endpoint, http_client=client, max_sse_event_size=1024 * 1024
                        ) as streams:
                            async with ClientSession(*streams, read_timeout_seconds=30) as session:
                                await session.initialize()
                                yield session
                else:
                    if not command or directory is None:
                        raise DomainError(422, "MCP进程配置缺失")
                    parameters = StdioServerParameters(
                        command=command[0],
                        args=command[1:],
                        cwd=str(directory),
                        env=tool_environment(directory),
                    )
                    with await asyncio.to_thread(open, os.devnull, "w", encoding="utf-8") as errors:
                        async with stdio_client(parameters, errlog=errors) as streams:
                            async with ClientSession(*streams, read_timeout_seconds=30) as session:
                                await session.initialize()
                                yield session
        except DomainError:
            raise
        except TimeoutError as error:
            raise DomainError(504, "MCP连接或调用超时") from error
        except ExceptionGroup as error:
            # Streamable HTTP 的任务组会包装调用方异常，保留已判定的 Schema 撤权语义。
            pending: list[BaseException] = list(error.exceptions)
            business: list[DomainError] = []
            while pending:
                current = pending.pop()
                if isinstance(current, BaseExceptionGroup):
                    pending.extend(current.exceptions)
                elif isinstance(current, DomainError):
                    business.append(current)
                else:
                    raise DomainError(502, "MCP连接或调用失败，请检查端点与配置") from error
            if business:
                raise business[0] from error
            raise DomainError(502, "MCP连接或调用失败，请检查端点与配置") from error
        except Exception as error:
            raise DomainError(502, "MCP连接或调用失败，请检查端点与配置") from error

    async def discover(self, session: ClientSession) -> list[dict[str, object]]:
        """分页发现有数量和游标界限，工具ID规范化后仍检查重复。"""
        tools: list[dict[str, object]] = []
        cursor: str | None = None
        visited: set[str] = set()
        while True:
            result = await session.list_tools(
                params=PaginatedRequestParams(cursor=cursor) if cursor else None
            )
            for tool in result.tools:
                if len(tools) >= 100:
                    raise DomainError(422, "MCP工具超过100个，请拆分连接")
                identifier = (
                    tool.name
                    if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,99}", tool.name)
                    else "mcp-" + digest(tool.name)[:20]
                )
                declaration: dict[str, object] = {
                    "id": identifier,
                    "remoteName": tool.name,
                    "name": (tool.title or tool.name)[:100],
                    "description": (tool.description or tool.name)[:4000],
                    "mode": "action",
                    "inputSchema": tool.input_schema,
                    "configurationSchema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                    "permissions": ["sessions.run"],
                    "artifactTypes": [],
                    "timeoutSeconds": 120,
                }
                if tool.output_schema is not None:
                    declaration["outputSchema"] = tool.output_schema
                tools.append(tool_descriptor(declaration))
            cursor = result.next_cursor
            if not cursor:
                break
            if cursor in visited:
                raise DomainError(502, "MCP发现游标重复")
            visited.add(cursor)
        if len({item["id"] for item in tools}) != len(tools):
            raise DomainError(422, "MCP工具标识重复")
        return tools

    async def call(
        self, session: ClientSession, descriptor: dict[str, object], arguments: dict[str, object]
    ) -> dict[str, object]:
        """执行前再次核对远端Schema，副作用调用不做自动重试。"""
        actual = next(
            (item for item in await self.discover(session) if item["id"] == descriptor["id"]), None
        )
        if actual is None or schema_digest(actual) != schema_digest(descriptor):
            raise DomainError(409, "MCP工具或Schema已改变，请管理员重新检查并授权")
        result = await session.call_tool(
            str(descriptor.get("remoteName", descriptor["id"])),
            arguments,
            read_timeout_seconds=float(str(descriptor.get("timeoutSeconds", 120))),
        )
        payload = result.model_dump(mode="json", exclude_none=True, by_alias=True)
        if payload.get("isError"):
            raise DomainError(502, "MCP工具执行失败")
        return payload


def schema_digest(tool: dict[str, object]) -> str:
    """摘要仅包含执行契约，名称和说明变化不构成执行授权。"""
    return digest(
        {key: tool.get(key) for key in ("id", "remoteName", "inputSchema", "outputSchema")}
    )

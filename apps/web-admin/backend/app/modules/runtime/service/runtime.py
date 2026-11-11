"""运行应用用例：按需准备、授权、稳定错误和状态读取。"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import cast

from app.modules.runtime.entity.bo.values import Fields, Json
from app.modules.runtime.service.ports import Authorize, RuntimeConfigurator, RuntimeRunner


class RuntimeService:
    """准备任务仅管理启动生命周期，消息执行全部交由 DSH 原队列。"""

    def __init__(self, runner: RuntimeRunner, authorize: Authorize) -> None:
        self.runner, self.authorize = runner, authorize
        self._preparing: dict[str, asyncio.Task[Fields]] = {}
        self.on_prepare: Callable[[str], Awaitable[None]] | None = None

    async def view(self, owner: str) -> Fields:
        """纯状态查询，不启动引擎或创建运行目录。"""
        await self.authorize(owner)
        state = self.runner.status(owner)
        if owner in self._preparing:
            state["status"] = "starting"
        return state

    async def is_ready(self) -> bool:
        """就绪检查要求唯一监督器租约有效，不要求登录时已启动用户 Host。"""
        return await self.runner.is_ready()

    async def prepare(self, owner: str) -> Fields:
        """显式启动任务可重复调用，同用户只保留一个准备任务。"""
        await self.authorize(owner)
        if self.on_prepare:
            await self.on_prepare(owner)
        if owner not in self._preparing and self.runner.status(owner).get("status") != "running":
            task = asyncio.create_task(self.runner.prepare(owner))
            self._preparing[owner] = task
            task.add_done_callback(lambda completed: self._finished(owner, completed))
        return await self.view(owner)

    def _finished(self, owner: str, task: asyncio.Task[Fields]) -> None:
        if self._preparing.get(owner) is task:
            self._preparing.pop(owner, None)
        if not task.cancelled():
            task.exception()  # 错误已由监督器变为可见 error 状态；回收任务异常。

    async def stop(self, owner: str) -> None:
        """取消启动任务并停止当前用户实例，等待所有清理完成。"""
        await self.authorize(owner)
        task = self._preparing.get(owner)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self.runner.stop(owner)

    async def call(self, owner: str, method: str, params: Fields) -> Json:
        """执行用例只通过同一运行端口提交，不做模型或引擎回退。"""
        await self.authorize(owner)
        return await self.runner.call(owner, method, params)

    async def events(self, owner: str, after: int) -> list[Fields]:
        """按用户及游标读取已持久证据。"""
        await self.authorize(owner)
        return await self.runner.events(owner, after)

    async def install_tool(self, owner: str, tool: Fields) -> None:
        """仅会话冻结绑定用例安装工具，浏览器没有直接入口。"""
        await self.authorize(owner)
        await cast(RuntimeConfigurator, self.runner).install_tool(owner, tool)

    async def install_preset(self, owner: str, preset: Fields) -> None:
        """受管预设不允许客户端指定任意 Cordis 插件或文件路径。"""
        await self.authorize(owner)
        await cast(RuntimeConfigurator, self.runner).install_preset(owner, preset)

    async def close(self) -> None:
        """应用退出时先取消准备，再关闭唯一监督器。"""
        for task in self._preparing.values():
            task.cancel()
        await asyncio.gather(*self._preparing.values(), return_exceptions=True)
        await self.runner.close()

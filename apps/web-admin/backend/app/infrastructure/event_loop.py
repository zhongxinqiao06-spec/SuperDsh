"""平台事件循环：Windows 热重载仍必须支持 DSH 子进程与异步管道。"""

import asyncio
import sys


def create_event_loop() -> asyncio.AbstractEventLoop:
    """供 Uvicorn 与独立启动器共用，避免 reload 模式切到不支持子进程的 Selector。"""
    if sys.platform == "win32":
        return asyncio.ProactorEventLoop()

    # 其他平台保留 Uvicorn 的自动选择（已安装 uvloop 时继续使用），不改变部署性能策略。
    from uvicorn.loops.auto import auto_loop_factory

    return auto_loop_factory()()

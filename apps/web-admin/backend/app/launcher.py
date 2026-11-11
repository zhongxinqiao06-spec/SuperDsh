"""跨平台启动器：父进程关闭 stdin 时先执行 ASGI 生命周期清理。"""

import argparse
import asyncio
import json
import sys
import threading

import uvicorn

from app.infrastructure.control_channel import control_lines
from app.infrastructure.event_loop import create_event_loop


async def serve(host: str, port: int) -> None:
    """Windows 通过受管 stdin 请求优雅关闭，Linux 仍使用 uvicorn 信号处理。"""
    server = uvicorn.Server(
        uvicorn.Config(
            "app.main:create_app",
            factory=True,
            host=host,
            port=port,
            workers=1,
            timeout_graceful_shutdown=75,
        )
    )
    loop = asyncio.get_running_loop()
    monitor_stopped = threading.Event()

    def stop() -> None:
        server.should_exit = True

    def monitor_parent() -> None:
        # 守护读取线程不延长进程生命；任何父管道关闭都必须回收受管 Host。
        try:
            for line in control_lines(sys.stdin, monitor_stopped):
                try:
                    message = json.loads(line)
                    if isinstance(message, dict) and message.get("command") == "shutdown":
                        return
                except (ValueError, TypeError):
                    continue
        except (OSError, ValueError):
            pass  # 控制通道损坏与父进程退出具有相同清理语义。
        finally:
            if not monitor_stopped.is_set() and not loop.is_closed():
                loop.call_soon_threadsafe(stop)

    monitor = None
    if not sys.stdin.isatty():
        monitor = threading.Thread(target=monitor_parent, name="platform-parent", daemon=True)
        monitor.start()
    try:
        await server.serve()
    finally:
        monitor_stopped.set()
        if monitor is not None and sys.platform == "win32":
            await asyncio.to_thread(monitor.join, 1)


def main() -> None:
    """由根 Node 调度器传递显式 host/port，不隐式启动旧平台。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    with asyncio.Runner(loop_factory=create_event_loop) as runner:
        runner.run(serve(args.host, args.port))


if __name__ == "__main__":
    main()

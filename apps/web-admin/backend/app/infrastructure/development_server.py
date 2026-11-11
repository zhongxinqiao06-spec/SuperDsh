"""开发服务接线：保留 Uvicorn 重载，同时隔离 Windows 每代工作进程的监听句柄。"""

import sys
from functools import partial
from socket import socket

import uvicorn
from uvicorn.supervisors import ChangeReload


def _serve_worker(config: uvicorn.Config, sockets: list[socket] | None = None) -> None:
    # Windows 的空列表表示不继承父监听句柄；None 让当前 worker 自行绑定端口。
    # 同一句柄一旦属于上一代 IOCP，下一代 Proactor 重新注册便会产生 WinError 87。
    uvicorn.Server(config).run(sockets=sockets or None)


def run_development_server(config: uvicorn.Config) -> None:
    """运行单 worker 开发服务；上一代完成 ASGI 清理后才启动下一代监听。"""
    if config.workers != 1:
        raise ValueError("本地开发入口只允许一个后端工作进程")
    if config.should_reload:
        # 继续使用依赖自身的文件过滤、信号转发与 join 顺序，不另造热重载监督器。
        # Unix 保留原有父监听 socket；Windows 每代创建新 socket，以兼容异步子进程。
        sockets = [] if sys.platform == "win32" else [config.bind_socket()]
        try:
            ChangeReload(config, target=partial(_serve_worker, config), sockets=sockets).run()
        except KeyboardInterrupt:
            pass
    else:
        server = uvicorn.Server(config)
        server.run()
        if not server.started:
            raise RuntimeError("后端服务未能完成启动")

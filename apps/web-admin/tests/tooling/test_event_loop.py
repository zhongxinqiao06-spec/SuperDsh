"""真实异步子进程回归；覆盖热重载使用的 Uvicorn 循环配置，不启动平台或数据库。"""

import asyncio
import sys

import pytest
from uvicorn import Config


@pytest.mark.parametrize("reload,workers", [(True, 1), (False, 1), (False, 2)])
def test_server_loop_keeps_subprocess_pipes(reload: bool, workers: int) -> None:
    """启用重载/worker 后也能同时写 stdin、读 stdout/stderr，并等待退出完成。"""
    config = Config(
        "app.main:create_app",
        factory=True,
        reload=reload,
        workers=workers,
        loop="app.infrastructure.event_loop:create_event_loop",
    )

    async def exercise() -> tuple[int | None, bytes, bytes]:
        child = await asyncio.create_subprocess_exec(
            sys.executable,
            "-B",
            "-c",
            "import sys; value=sys.stdin.readline().strip(); "
            "print(value); print('diagnostic-ready', file=sys.stderr)",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            output, errors = await asyncio.wait_for(child.communicate(b"host-ready\n"), 10)
            return child.returncode, output.strip(), errors.strip()
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()

    with asyncio.Runner(loop_factory=config.get_loop_factory()) as runner:
        assert runner.run(exercise()) == (0, b"host-ready", b"diagnostic-ready")

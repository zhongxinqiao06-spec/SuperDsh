"""真实 Windows 子孙进程清理，不依赖 DSH mock 来证明内核 Job 行为。"""

from __future__ import annotations

import asyncio
import contextlib
import sys

import pytest

from app.integrations.dsh.process_identity import process_is_alive
from app.integrations.dsh.process_tree import WindowsProcessTree


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Object 的真实平台验证")
@pytest.mark.asyncio
async def test_windows_job_reaps_descendant_after_root_exits() -> None:
    """根进程提前退出后关闭 Job 仍能回收孙进程，且不会依赖已消失的 PID 树。"""
    source = (
        "import subprocess,sys; "
        "sys.stdin.readline(); "
        'child=subprocess.Popen([sys.executable,"-B","-c","import time;time.sleep(90)"]); '
        "print(child.pid,flush=True); sys.stdin.readline()"
    )
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-B",
        "-c",
        source,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        creationflags=0x08000000,
    )
    tree = WindowsProcessTree()
    try:
        tree.attach(process.pid)
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(b"spawn\n")
        await process.stdin.drain()
        descendant = int(await asyncio.wait_for(process.stdout.readline(), 5))
        assert process_is_alive(descendant)
        process.stdin.write(b"exit\n")
        await process.stdin.drain()
        # 孙进程仍持有 stdout 时 asyncio.wait 会等待管道关闭；先核实根进程确已退出。
        async with asyncio.timeout(5):
            # 此处专门验证根退出但后代仍持有管道；Process.wait 的管道条件不等价。
            while process.returncode is None:  # noqa: ASYNC110
                await asyncio.sleep(0.02)
        assert process_is_alive(descendant)
        tree.close()
        await asyncio.wait_for(process.stdout.read(), 5)
        await asyncio.wait_for(process.wait(), 5)
        async with asyncio.timeout(5):
            # 孙进程不归 asyncio 管理，没有 Process/Event；观察真实内核退出事实。
            while process_is_alive(descendant):  # noqa: ASYNC110
                await asyncio.sleep(0.02)
    finally:
        tree.close()
        if process.returncode is None:
            process.kill()
        await process.wait()
        if process.stdin is not None:
            process.stdin.close()
            with contextlib.suppress(ConnectionError, OSError):
                await process.stdin.wait_closed()
        if process.stdout is not None:
            await asyncio.wait_for(process.stdout.read(), 5)

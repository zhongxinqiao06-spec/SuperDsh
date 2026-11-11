"""真实 stdin 管道与 spawn 原生依赖回归，不能用模拟线程或假工作进程替代。"""

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from queue import Queue
from threading import Thread

import pytest


@pytest.mark.parametrize("shutdown", [b'{"command":"shutdown"}\n', b""])
def test_control_pipe_does_not_block_spawn(shutdown: bytes) -> None:
    """父管道持续打开时完成任务，再分别通过命令和 EOF 优雅退出。"""
    root = Path(__file__).resolve().parents[4] / ".superdsh-work/web-admin-validation"
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="control-spawn-", dir=root) as temporary:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).parents[1] / "fixtures/control_spawn.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                **os.environ,
                "PYTHONPYCACHEPREFIX": temporary,
                "PYTHONPATH": str(Path(__file__).parents[2] / "backend"),
            },
        )
        output = process.stdout
        assert output is not None
        ready: Queue[bytes] = Queue()
        reader = Thread(target=lambda: ready.put(output.readline()), daemon=True)
        reader.start()
        try:
            line = ready.get(timeout=20).strip()
            if line != b"SPAWN_OK":
                _, errors = process.communicate(timeout=5)
                raise AssertionError(errors.decode(errors="replace"))
            reader.join(1)
            if shutdown:
                assert process.stdin is not None
                process.stdin.write(shutdown[:8])
                process.stdin.flush()
                time.sleep(0.1)
                assert process.poll() is None, "半条控制消息不能关闭服务"
                shutdown = shutdown[8:]
            _, errors = process.communicate(shutdown, timeout=15)
            assert process.returncode == 0, errors.decode(errors="replace")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)

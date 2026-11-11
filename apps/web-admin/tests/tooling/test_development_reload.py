"""真实监听、连续热重载和子进程回收回归，不依赖数据库或外部服务。"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest


def wait_probe(port: int, previous: set[int], process: subprocess.Popen[bytes]) -> int:
    """必须由新 PID 同时完成 HTTP 与异步子进程请求，不能只看启动日志。"""
    deadline = time.monotonic() + 25
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        assert process.poll() is None, "重载器提前退出"
        try:
            with opener.open(f"http://127.0.0.1:{port}/probe", timeout=1) as response:
                result = json.load(response)
            if result["pid"] in previous:
                # 正在退出的旧代请求可能同时收到控制台退出信号；只验收新代能力。
                time.sleep(0.15)
                continue
            assert result["childCode"] == 0
            assert result["output"] == "subprocess-ready"
            assert result["errors"] == ""
            return int(result["pid"])
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.15)
    raise AssertionError("重载后 HTTP 或异步子进程未恢复")


@pytest.mark.skipif(sys.platform != "win32", reason="验证 Windows IOCP 与控制台重载边界")
def test_windows_reload_rebinds_listener_and_reaps_children(tmp_path: Path) -> None:
    """初次启动和连续两次重载均可请求，三代 ASGI 子进程均完成关闭。"""
    repository = Path(__file__).resolve().parents[4]
    backend = repository / "apps/web-admin/backend"
    tests = repository / "apps/web-admin/tests"
    watched = tmp_path / "watched"
    watched.mkdir()
    trigger = watched / "generation.py"
    trigger.write_text("generation = 0\n", encoding="utf-8")
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("WEB_ADMIN_")
    }
    environment.update(
        {
            "PYTHONPATH": os.pathsep.join((str(backend), str(tests))),
            "PYTHONPYCACHEPREFIX": str(tmp_path / "pycache"),
            "RELOAD_PROBE_OUTPUT": str(tmp_path / "lifecycles.jsonl"),
        }
    )
    # 独立控制台防止 Uvicorn 的 CTRL_C 重载信号传播给测试器；窗口始终隐藏。
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    with (tmp_path / "server.log").open("wb") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "fixtures.runtime.reload_probe",
                "--port",
                str(port),
                "--watch",
                str(watched),
                "--stop",
                str(tmp_path / "stop"),
            ],
            cwd=backend,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
            startupinfo=startup,
        )
        try:
            generations = {wait_probe(port, set(), process)}
            for generation in (1, 2):
                # 等待文件观察器完成首轮订阅；写入发生在上一代确实可请求之后。
                time.sleep(0.5)
                trigger.write_text(f"generation = {generation}\n", encoding="utf-8")
                generations.add(wait_probe(port, generations, process))
            assert len(generations) == 3
        finally:
            if process.poll() is None:
                (tmp_path / "stop").write_text("stop", encoding="utf-8")
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    pytest.fail("重载器未完成优雅关闭；隔离进程需要检查")
    assert process.returncode == 0
    events = [
        json.loads(line) for line in (tmp_path / "lifecycles.jsonl").read_text("utf-8").splitlines()
    ]
    stopped = {
        entry["pid"]
        for entry in events
        if entry["kind"] == "shutdown" and entry["returncode"] is not None
    }
    assert stopped == generations
    assert "WinError 87" not in (tmp_path / "server.log").read_text("utf-8", errors="replace")
    with socket.socket() as connection:
        assert connection.connect_ex(("127.0.0.1", port)) != 0

"""跨平台伪终端进程适配，运行产物不进入代码目录。"""

import importlib
import os
import select
import signal
import socket
import struct
import subprocess
from pathlib import Path
from typing import Protocol, cast

from app.infrastructure.errors import DomainError


class TerminalProcess(Protocol):
    """终端与 Agent 引擎互不替代，接口只提供进程 I/O。"""

    def read(self) -> str: ...
    def write(self, data: str) -> None: ...
    def resize(self, rows: int, cols: int) -> None: ...
    def alive(self) -> bool: ...
    def close(self) -> None: ...
    @property
    def pid(self) -> int: ...


class WindowsPty(Protocol):
    """pywinpty 的稳定进程契约，平台依赖在实际创建时加载。"""

    fileobj: socket.socket
    pid: int

    def read(self, size: int = 4096) -> str: ...
    def write(self, data: str) -> int: ...
    def setwinsize(self, rows: int, cols: int) -> None: ...
    def isalive(self) -> bool: ...
    def close(self, force: bool = True) -> None: ...


class PtyModule(Protocol):
    """在 Windows 类型检查时仍明确 POSIX 模块的调用契约。"""

    def openpty(self) -> tuple[int, int]: ...


class IoctlModule(Protocol):
    def ioctl(self, fd: int, command: int, data: bytes) -> int: ...


class TermiosModule(Protocol):
    TIOCSWINSZ: int


class ProcessSignals(Protocol):
    def killpg(self, pid: int, signal: int) -> None: ...


class SignalModule(Protocol):
    SIGKILL: int


class WindowsProcess:
    def __init__(
        self, cwd: Path, home: Path, rows: int, cols: int, shell: str, args: list[str]
    ) -> None:
        try:
            module = importlib.import_module("winpty")
            self.process = cast(
                WindowsPty,
                module.PtyProcess.spawn(
                    subprocess.list2cmdline([shell, *args]),
                    cwd=str(cwd),
                    env={**os.environ, "USERPROFILE": str(home)},
                    dimensions=(rows, cols),
                ),
            )
        except (ImportError, OSError) as error:
            raise DomainError(503, "Windows terminal dependency is unavailable") from error

    def read(self) -> str:
        # PtyProcess.read 是阻塞 socket 包装；先等待可读避免空闲终端阻塞清理。
        readable, _, _ = select.select([self.process.fileobj], [], [], 0.2)
        return self.process.read(4096) if readable else ""

    def write(self, data: str) -> None:
        self.process.write(data)

    def resize(self, rows: int, cols: int) -> None:
        self.process.setwinsize(rows, cols)

    def alive(self) -> bool:
        return self.process.isalive()

    def close(self) -> None:
        try:
            self.process.close(force=True)
        except PermissionError:
            # 部分Windows运行环境拒绝os.kill，仍只能回收本PTY持有的子进程树。
            if self.process.isalive():
                subprocess.run(
                    ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=10,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            if self.process.isalive():
                raise DomainError(503, "terminal process did not stop") from None
            self.process.close(force=True)

    @property
    def pid(self) -> int:
        return self.process.pid


class PosixProcess:
    def __init__(
        self, cwd: Path, home: Path, rows: int, cols: int, shell: str, args: list[str]
    ) -> None:
        pty = cast(PtyModule, importlib.import_module("pty"))

        self.master, slave = pty.openpty()
        try:
            self.process = subprocess.Popen(
                [shell, *args],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env={**os.environ, "HOME": str(home), "TERM": "xterm-256color"},
                start_new_session=True,
            )
        except BaseException:
            os.close(self.master)
            raise
        finally:
            os.close(slave)
        os.set_blocking(self.master, False)
        self.resize(rows, cols)

    def read(self) -> str:
        try:
            return os.read(self.master, 4096).decode("utf-8", errors="replace")
        except BlockingIOError:
            return ""

    def write(self, data: str) -> None:
        os.write(self.master, data.encode())

    def resize(self, rows: int, cols: int) -> None:
        fcntl = cast(IoctlModule, importlib.import_module("fcntl"))
        termios = cast(TermiosModule, importlib.import_module("termios"))

        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def alive(self) -> bool:
        return self.process.poll() is None

    def close(self) -> None:
        if self.alive():
            signals = cast(ProcessSignals, importlib.import_module("os"))
            signals.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                signals.killpg(
                    self.process.pid, cast(SignalModule, importlib.import_module("signal")).SIGKILL
                )
                self.process.wait(5)
        os.close(self.master)

    @property
    def pid(self) -> int:
        return self.process.pid


def spawn(
    cwd: Path,
    home: Path,
    rows: int,
    cols: int,
    shell: str | None = None,
    args: list[str] | None = None,
) -> TerminalProcess:
    """授权后的终端保留shell/args；直接传进程参数，不经过额外shell解释。

    Home与工作目录仍由所属账号决定，这是产品权限边界而非操作系统沙箱。
    与原生旧端一致，客户端env不覆盖受管Home或服务环境。
    """
    home.mkdir(parents=True, exist_ok=True)
    cwd.mkdir(parents=True, exist_ok=True)
    windows = os.name == "nt"
    executable = shell or ("powershell.exe" if windows else "/bin/sh")
    arguments = args if args is not None else (["-NoLogo", "-NoProfile"] if windows else ["-i"])
    try:
        return (
            WindowsProcess(cwd, home, rows, cols, executable, arguments)
            if windows
            else PosixProcess(cwd, home, rows, cols, executable, arguments)
        )
    except OSError as error:
        raise DomainError(502, "terminal failed to start") from error

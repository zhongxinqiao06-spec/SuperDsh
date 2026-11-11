"""父进程控制管道：Windows 不挂起阻塞读，避免阻塞继承 stdin 的工作进程启动。"""

import os
import sys
from collections.abc import Iterator
from threading import Event
from typing import TextIO


def control_lines(stream: TextIO, stopped: Event | None = None) -> Iterator[str]:
    """唯一消费者读取有界控制行；管道关闭即结束，普通文件与 Unix 保持原生读取。"""
    if sys.platform != "win32":
        yield from stream
        return

    import _winapi
    import msvcrt

    descriptor = stream.fileno()
    stopped = stopped or Event()
    handle = msvcrt.get_osfhandle(descriptor)
    if _winapi.GetFileType(handle) != _winapi.FILE_TYPE_PIPE:
        yield from stream
        return
    pending = bytearray()
    while not stopped.is_set():
        try:
            available = _winapi.PeekNamedPipe(handle)[0]
        except OSError as error:
            if error.winerror in {109, 232}:  # 父管道关闭，没有更多控制数据。
                return
            raise
        if not isinstance(available, int):
            raise OSError("控制管道返回了无效可读长度")
        if not available:
            # 阻塞 ReadFile 会卡住继承同一 stdin 的子解释器初始化；只读取已到达字节。
            stopped.wait(0.05)
            continue
        chunk = os.read(descriptor, min(available, 4096))
        if not chunk:
            return
        pending.extend(chunk)
        if len(pending) > 65536:
            raise OSError("控制消息超过允许长度")
        while b"\n" in pending:
            line, _, remaining = pending.partition(b"\n")
            pending = bytearray(remaining)
            yield line.decode("utf-8", errors="replace")

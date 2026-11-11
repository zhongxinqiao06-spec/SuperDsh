"""只读核实旧执行者是否已退出；无法证明退出时保持拒绝接管。"""

from __future__ import annotations

import ctypes
import os
import platform
import sys
from pathlib import Path


def machine_identity() -> str:
    """Linux 将 PID 命名空间纳入身份，不能用新容器的 PID 表证明旧容器退出。"""
    namespace = Path("/proc/self/ns/pid")
    suffix = os.readlink(namespace) if namespace.exists() else "host"
    return f"{platform.system()}:{platform.node()}:{suffix}"


def process_is_alive(pid: int) -> bool:
    """只读检查；PID 被复用或权限不足都视为仍存活，不向未知 PID 发终止信号。"""
    if pid <= 0:
        return True
    if sys.platform == "win32":
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

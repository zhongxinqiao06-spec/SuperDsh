"""Windows 受管进程树使用内核 Job，监督器崩溃也不能遗留执行中的孙进程。"""

from __future__ import annotations

import ctypes
import sys

from .protocol import RuntimeFailure


class WindowsProcessTree:
    """Job 句柄不继承，最后句柄关闭时内核终止整个树；这不是权限沙箱。"""

    def __init__(self) -> None:
        self.handle: int | None = None

    def attach(self, pid: int) -> None:
        """在允许执行命令前将 Host 纳入 Job；无法纳管就拒绝启动。"""
        if sys.platform != "win32":
            return
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_int64),
                ("job_time", ctypes.c_int64),
                ("flags", wintypes.DWORD),
                ("min_working", ctypes.c_size_t),
                ("max_working", ctypes.c_size_t),
                ("active_processes", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_uint64)
                for name in (
                    "read_ops",
                    "write_ops",
                    "other_ops",
                    "read_bytes",
                    "write_bytes",
                    "other_bytes",
                )
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits),
                ("io", IoCounters),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process", ctypes.c_size_t),
                ("peak_job", ctypes.c_size_t),
            ]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.CreateJobObjectW(None, None)
        if not handle:
            raise RuntimeFailure("runtime_process_tree_unavailable", "无法建立引擎进程树所有权")
        self.handle = handle
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            if not kernel.SetInformationJobObject(
                handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
            ):
                raise RuntimeFailure("runtime_process_tree_unavailable", "无法配置引擎进程树所有权")
            process = kernel.OpenProcess(0x0100 | 0x0001, False, pid)
            if not process:
                raise RuntimeFailure("runtime_process_tree_unavailable", "无法访问受管引擎进程")
            try:
                if not kernel.AssignProcessToJobObject(handle, process):
                    raise RuntimeFailure("runtime_process_tree_unavailable", "无法纳管引擎进程树")
            finally:
                kernel.CloseHandle(process)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """内核回收整个树；调用可重复且不依赖已经退出的根 PID。"""
        if self.handle is None or sys.platform != "win32":
            return
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        kernel.CloseHandle(self.handle)
        self.handle = None

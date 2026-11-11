"""仅测试使用的受控 CPU/失败/等待任务。"""

import hashlib
import os
import time
from pathlib import Path


def digest(payload: dict[str, object], directory: str) -> dict[str, object]:
    """写合成文件并返回真实摘要，校验清理覆盖文件副作用。"""
    data = str(payload["value"]).encode()
    Path(directory, "synthetic.txt").write_bytes(data)
    return {"digest": hashlib.sha256(data).hexdigest()}


def wait(payload: dict[str, object], directory: str) -> dict[str, object]:
    """受控阻塞用于证明超时和取消会回收实际进程。"""
    Path(directory, "started").write_text("started")
    time.sleep(30)
    return {}


def thread_limits(payload: dict[str, object], directory: str) -> dict[str, object]:
    """在真实子进程读取资源约束，不导入大型数值库干扰此边界测试。"""
    return {
        key: os.environ.get(key)
        for key in (
            "OPENBLAS_NUM_THREADS",
            "OMP_NUM_THREADS",
            "MKL_NUM_THREADS",
            "NUMEXPR_NUM_THREADS",
        )
    }

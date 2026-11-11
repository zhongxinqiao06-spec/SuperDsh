"""真实子进程取消、超时和退出清理，不用 mock 宣称已释放资源。"""

import asyncio
import hashlib
import os
from pathlib import Path

import pytest
from worker_fixtures import digest, thread_limits, wait

from app.infrastructure.errors import DomainError
from app.workers.processes import ProcessWorkers


async def test_worker_success_timeout_cancel_and_close() -> None:
    root = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / "worker-fixture"
    worker = ProcessWorkers(root)
    try:
        result = await worker.submit(digest, {"value": "synthetic"})
        assert result == {"digest": hashlib.sha256(b"synthetic").hexdigest()}
        with pytest.raises(DomainError, match="timed out"):
            await worker.submit(wait, {}, timeout=0.15)
        task = worker.submit(wait, {})
        await asyncio.sleep(0.15)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        worker.submit(wait, {})
        await asyncio.sleep(0.15)
    finally:
        await worker.close()
    assert not worker.tasks
    assert list(root.iterdir()) == []


async def test_worker_native_threads_are_bounded_without_changing_parent() -> None:
    """宿主机高线程配置不能击穿工作池并发预算，关闭后仍回收本轮目录。"""
    root = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / "worker-thread-fixture"
    keys = ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS")
    previous = {key: os.environ.get(key) for key in keys}
    worker = ProcessWorkers(root, native_threads=1)
    try:
        assert await worker.submit(thread_limits, {}) == dict.fromkeys(keys, "1")
        assert {key: os.environ.get(key) for key in keys} == previous
    finally:
        await worker.close()
    assert list(root.iterdir()) == []

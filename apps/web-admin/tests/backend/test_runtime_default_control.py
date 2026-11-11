"""默认配置控制请求的并发关联、失败和取消；不启动真实引擎或创建账号。"""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.integrations.dsh.process import HarnessProcess
from app.integrations.dsh.protocol import RuntimeFailure


@pytest.fixture
def process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> HarnessProcess:
    """仅替换出站管道，保留真实请求登记及响应解析。"""
    instance = HarnessProcess(
        "synthetic-node", tmp_path, tmp_path, tmp_path, {}, "owner", AsyncMock()
    )
    monkeypatch.setattr(instance, "send", AsyncMock())
    return instance


async def test_concurrent_responses_are_correlated(process: HarnessProcess) -> None:
    first = asyncio.create_task(process.runtime_defaults())
    second = asyncio.create_task(process.runtime_defaults())
    await asyncio.sleep(0)
    identifiers = list(process._default_reads)
    assert len(identifiers) == 2
    for identifier, preset in reversed(list(zip(identifiers, ["first", "second"], strict=True))):
        await process._control(
            {"type": "runtime-defaults", "id": identifier, "defaults": {"permissionPreset": preset}}
        )
    assert await first == {"permissionPreset": "first"}
    assert await second == {"permissionPreset": "second"}
    assert not process._default_reads


async def test_cancel_ignores_late_response(process: HarnessProcess) -> None:
    task = asyncio.create_task(process.runtime_defaults())
    await asyncio.sleep(0)
    identifier = next(iter(process._default_reads))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await process._control(
        {"type": "runtime-defaults", "id": identifier, "defaults": {"permissionPreset": "late"}}
    )
    assert not process._default_reads


@pytest.mark.parametrize("cause", ["malformed", "host_error", "stopped", "timeout"])
async def test_failures_release_pending_request(
    process: HarnessProcess, cause: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    if cause == "timeout":
        monkeypatch.setattr(process, "send", AsyncMock(side_effect=TimeoutError))
    task = asyncio.create_task(process.runtime_defaults())
    await asyncio.sleep(0)
    if cause == "stopped":
        await process.stop()
    elif cause != "timeout":
        identifier = next(iter(process._default_reads))
        await process._control(
            {
                "type": "runtime-defaults",
                "id": identifier,
                "error": cause == "host_error",
                "defaults": None,
            }
        )
    with pytest.raises(RuntimeFailure) as error:
        await task
    assert error.value.code == "permission_default_unavailable"
    assert not process._default_reads


async def test_pending_reads_are_bounded(process: HarnessProcess) -> None:
    tasks = [asyncio.create_task(process.runtime_defaults()) for _ in range(32)]
    await asyncio.sleep(0)
    try:
        with pytest.raises(RuntimeFailure, match="读取繁忙"):
            await process.runtime_defaults()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    assert not process._default_reads

"""DSH 工具错误只公开明确允许的无输入值字段提示。"""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.infrastructure.errors import DomainError
from app.integrations.dsh.process import HarnessProcess
from app.integrations.dsh.protocol import Fields


@pytest.mark.parametrize(
    "error,visible",
    [
        (DomainError(422, "scenes.0.scriptRange: type", "tool_arguments_invalid"), True),
        (DomainError(422, "scenes.0.scriptRange: object", "studio_tool_arguments_invalid"), True),
        (DomainError(500, "private-server-data", "tool_arguments_invalid"), False),
        (DomainError(422, "private-config-data", "configuration_invalid"), False),
        (RuntimeError("private-exception-data"), False),
    ],
)
async def test_process_only_publishes_allowlisted_validation_messages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception, visible: bool
) -> None:
    async def failed(owner: str, message: Fields) -> Fields:
        raise error

    process = HarnessProcess(
        "node", tmp_path / "anchor", tmp_path / "home", tmp_path / "work", {}, "synthetic", failed
    )
    sent = AsyncMock()
    monkeypatch.setattr(process, "send", sent)
    await process._invoke("call", {})
    assert sent.await_args is not None
    frame = sent.await_args.args[0]
    assert frame["type"] == "tool-result" and frame["id"] == "call"
    if visible:
        assert frame["error"]["status"] == 422 and frame["error"]["detail"] == str(error)
    else:
        assert frame["error"] is True


async def test_process_bounds_safe_tool_error_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def failed(owner: str, message: Fields) -> Fields:
        raise DomainError(422, "x" * 2000, "tool_arguments_invalid")

    process = HarnessProcess(
        "node", tmp_path / "anchor", tmp_path / "home", tmp_path / "work", {}, "synthetic", failed
    )
    sent = AsyncMock()
    monkeypatch.setattr(process, "send", sent)
    await process._invoke("call", {})
    assert sent.await_args is not None
    assert len(sent.await_args.args[0]["error"]["detail"]) == 1000

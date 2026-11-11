"""启动诊断只保留固定类别，不把受管进程的任意字符串写入应用日志。"""

import logging
from pathlib import Path

import pytest

from app.integrations.dsh.diagnostics import safe_startup_diagnostic
from app.integrations.dsh.process import HarnessProcess
from app.integrations.dsh.protocol import Fields, Json


def test_unknown_or_private_diagnostic_fields_are_dropped() -> None:
    assert safe_startup_diagnostic(
        {
            "diagnostic": {
                "stage": "private-stage",
                "name": "private-name",
                "code": "private-key",
                "message": "private-body",
                "stack": "private-stack",
            }
        }
    ) == {"stage": "unknown", "name": "UnknownError", "code": "unclassified"}
    assert safe_startup_diagnostic({"diagnostic": ["private"]}) == {
        "stage": "unknown",
        "name": "UnknownError",
        "code": "unclassified",
    }


async def test_host_failure_records_only_safe_diagnostic(caplog: pytest.LogCaptureFixture) -> None:
    async def forbidden_tool(owner: str, message: Fields) -> Json:
        raise AssertionError("诊断测试不执行工具")

    process = HarnessProcess(
        "synthetic-node",
        Path("unused"),
        Path("unused"),
        Path("unused"),
        {},
        "owner",
        forbidden_tool,
    )
    with caplog.at_level(logging.WARNING, logger="web_admin"):
        await process._control(
            {
                "type": "host-error",
                "diagnostic": {
                    "stage": "bridge-start",
                    "name": "Error",
                    "code": "runtime_bridge_not_ready",
                    "message": "private-key",
                    "stack": "private-stack",
                },
            }
        )
    assert process.failed.is_set()
    assert len(process.diagnostics) == 1
    assert "private" not in process.diagnostics[0]
    record = caplog.records[-1]
    assert record.getMessage() == "runtime_host_start_failed"
    assert record.__dict__["code"] == "bridge-start:Error:runtime_bridge_not_ready"
    assert "private" not in caplog.text

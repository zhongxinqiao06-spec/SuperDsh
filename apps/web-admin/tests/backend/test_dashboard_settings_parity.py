"""直接比较旧仪表盘设置更新与区间默认值，覆盖局部更新及非法输入。"""

import json
import subprocess
from pathlib import Path
from typing import cast

import pytest

from app.infrastructure.errors import DomainError
from app.modules.management.entity.bo.dashboard_settings import merge_settings, overview_range
from app.modules.management.entity.vo.system_vo import DashboardSettingsPatchInput

ROOT = Path(__file__).resolve().parents[4]
CURRENT: dict[str, object] = {
    "intensity": {"basis": "messages", "lightMax": 7, "mediumMax": 21},
    "histogramBins": {"messages": [0, 8], "sessions": [0, 3]},
}
PATCHES: list[dict[str, object]] = [
    {},
    {"intensity": {"lightMax": 20, "mediumMax": 5}},
    {"histogramBins": {"messages": [9, 1, 9], "sessions": [2]}},
    {"intensity": {"basis": "sessions"}},
    {"intensity": {}},
    {"intensity": None},
    {"histogramBins": None},
    {"histogramBins": {"messages": [1]}},
    {"unrelated": True},
    {"intensity": {"lightMax": "0x10", "mediumMax": "2e1"}},
    {"intensity": {"lightMax": True, "mediumMax": None}},
    {"histogramBins": {"messages": [None, "", "3", []], "sessions": [1]}},
    {"intensity": {"lightMax": -1}},
    {"intensity": {"lightMax": 1.5}},
    {"histogramBins": {"messages": [-1], "sessions": [0]}},
]
QUERIES = [
    {"to": "2025-04-19"},
    {"to": "2025-04-19", "tz": ""},
    {"from": "2025-04-01", "to": "2025-04-19", "tz": "UTC"},
]


@pytest.fixture(scope="module")
def old_results() -> list[dict[str, object]]:
    process = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/dashboard-settings-oracle.ts")],
        input=json.dumps(
            [{"body": body, "current": CURRENT} for body in PATCHES]
            + [{"query": query} for query in QUERIES]
        ),
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=ROOT,
        timeout=30,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    return cast(list[dict[str, object]], json.loads(process.stdout))


@pytest.mark.parametrize("index", range(len(PATCHES)))
def test_partial_settings_match_old(index: int, old_results: list[dict[str, object]]) -> None:
    try:
        patch = DashboardSettingsPatchInput.model_validate(PATCHES[index])
        actual: dict[str, object] = {
            "status": 200,
            "value": merge_settings(CURRENT, patch.model_dump(exclude_unset=True)),
            "writes": 1,
        }
    except DomainError as error:
        actual = {"status": error.status, "detail": error.detail}
    assert actual == old_results[index]


@pytest.mark.parametrize("index", range(len(QUERIES)))
def test_overview_defaults_match_old(index: int, old_results: list[dict[str, object]]) -> None:
    query = QUERIES[index]
    start, end, zone = overview_range(
        query.get("from", ""), query.get("to", ""), query.get("tz", "")
    )
    assert {"status": 200, "value": {"from": start, "to": end, "zone": zone}} == old_results[
        len(PATCHES) + index
    ]

"""对契约投影差异逐入口归因；文档差异不能自动当作运行行为通过。"""

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import cast

ROOT = Path(__file__).resolve().parents[4]


def record(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


def schemas(contract: dict[str, object]) -> dict[str, dict[str, object]]:
    """按状态码和媒体类型保留响应描述，防止丢失文件/流式传输差异。"""
    result: dict[str, dict[str, object]] = {}
    for status, response in record(contract.get("responses")).items():
        for media, content in record(record(response).get("content")).items():
            result[status + ":" + media] = record(record(content).get("schema"))
    return result


def classify(source: Path, destination: Path) -> None:
    """输出仅限验证目录，使用已经实际执行的证据而非源码测试索引。"""
    destination = destination.resolve()
    if not destination.is_relative_to(ROOT / ".superdsh-work/web-admin-validation"):
        raise ValueError("契约审查报告输出越界")
    report = record(json.loads(source.read_text(encoding="utf-8")))
    evidence_path = (
        ROOT
        / ".superdsh-work/web-admin-validation/phase-three-api/identity-navigation-evidence.json"
    )
    evidence = (
        record(json.loads(evidence_path.read_text(encoding="utf-8")))
        if evidence_path.exists()
        else {}
    )
    observations = cast(list[dict[str, object]], evidence.get("cases", []))
    rows: list[dict[str, object]] = []
    for route in cast(list[dict[str, object]], report["routes"]):
        if route["contractStatus"] == "schema-equal-behavior-unverified":
            continue
        flags: list[str] = []
        old, new = record(route.get("oldContract")), record(route.get("newContract"))
        if not old:
            flags.append("legacy-operation-schema-missing")
        if not new:
            flags.append("new-operation-schema-missing-or-websocket")
        old_responses, new_responses = schemas(old), schemas(new)
        for key, old_schema in old_responses.items():
            new_schema = new_responses.get(key, {})
            if (
                old_schema.get("properties")
                and new_schema.get("type") == "object"
                and not new_schema.get("properties")
            ):
                flags.append("new-response-fields-not-modeled")
            if "422:" in key and "detail" in record(old_schema.get("properties")):
                flags.append("validation-error-schema-requires-runtime-review")
        if old and new:
            if old.get("requestBody") != new.get("requestBody"):
                flags.append("request-body-constraints-or-fields-differ")
            if set(record(old.get("responses"))) != set(record(new.get("responses"))):
                flags.append("documented-response-statuses-differ")
            old_parameters = cast(list[dict[str, object]], old.get("parameters", []))
            new_parameters = cast(list[dict[str, object]], new.get("parameters", []))
            if any(
                item.get("in") == "header" and item.get("name") == "Authorization"
                for item in old_parameters
            ) and not any(
                item.get("in") == "header" and item.get("name") == "Authorization"
                for item in new_parameters
            ):
                flags.append("authorization-dependency-not-declared-as-header-schema")
            if [item for item in old_parameters if item.get("in") != "header"] != [
                item for item in new_parameters if item.get("in") != "header"
            ]:
                flags.append("path-or-query-constraints-differ")
        pattern = "^" + re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(str(route["path"]))) + "$"
        matching = [
            item
            for item in observations
            if item.get("method") == route.get("method")
            and re.match(pattern, str(item.get("legacyPath", "")))
        ]
        rows.append(
            {
                "method": route["method"],
                "legacyPath": route["path"],
                "canonicalPath": route["canonical"],
                "contractStatus": route["contractStatus"],
                "findings": sorted(set(flags)),
                "observedCases": [
                    {"scenario": item["scenario"], "passed": item["passed"], "scope": item["scope"]}
                    for item in matching
                ],
                "decision": "partial-runtime-evidence-requires-full-scenario-review"
                if matching
                else "runtime-unverified",
                "schemaEqualityIsBehaviorEvidence": False,
            }
        )
    counts = Counter(flag for row in rows for flag in cast(list[str], row["findings"]))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(
            {
                "sourceReport": str(source.relative_to(ROOT)),
                "schemaDifferences": record(report.get("summary")).get("schemaDifferences"),
                "scope": "structural classification with explicitly bounded runtime evidence; no automatic parity approval",
                "findings": dict(sorted(counts.items())),
                "routes": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    classify(Path(sys.argv[1]).resolve(), Path(sys.argv[2]))

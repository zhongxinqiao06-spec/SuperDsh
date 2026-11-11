"""固定运行时失败的公开提示，保持重放时身份和摘要稳定。"""

import hashlib
import json
import re
from typing import cast


def _record(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


def runtime_failure_items(items: list[dict[str, object]]) -> list[dict[str, object]]:
    """保留原始轮次边界，并补充旧客户端可显示的脱敏失败条目。"""
    result: list[dict[str, object]] = []
    for item in items:
        result.append(item)
        reason = _record(_record(item.get("content")).get("reason"))
        if item.get("type") != "turn.end" or reason.get("kind") != "error":
            continue
        error = _record(reason.get("error", reason.get("failure")))
        limited = re.search(
            r"response incomplete: (length|max_output_tokens)",
            str(error.get("message", "")),
            re.IGNORECASE,
        )
        content = {
            "kind": "notice",
            "text": (
                "模型输出达到长度上限，本轮没有完成。请缩短本次修改范围，"
                "或调整所选模型的输出额度后再发送；系统不会自动重试。"
                if limited
                else "本轮执行失败，请检查模型或工具配置后重试。已生成的成果仍然保留。"
            ),
            "code": "MODEL_OUTPUT_LIMIT" if limited else "RUNTIME_EXECUTION_FAILED",
        }
        encoded = json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode()
        result.append(
            {
                **item,
                "id": f"{item.get('id', '')}:failure",
                "type": "system",
                "status": "failed",
                "role": "system",
                "content": content,
                "contentHash": "sha256:" + hashlib.sha256(encoded).hexdigest(),
            }
        )
    return result

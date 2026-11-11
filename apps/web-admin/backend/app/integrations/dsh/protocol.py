"""固定 RuntimeBridge 的 JSON 边界；协议版本来自契约资产而非应用发布版本。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from app.modules.runtime.entity.bo.values import Fields as Fields
from app.modules.runtime.entity.bo.values import Json as Json

FRAME_LIMIT = 8 * 1024 * 1024


class RuntimeFailure(Exception):
    """稳定运行错误，外层负责映射 HTTP；原始引擎消息不直接暴露凭据。"""

    def __init__(self, code: str, message: str, status: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def fields(value: object) -> Fields:
    """将 JSON 对象收敛为协议字段；数组或标量均拒绝。"""
    if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
        raise RuntimeFailure("invalid_runtime_frame", "运行时返回了非法数据", 502)
    return cast(Fields, value)


def contract() -> Fields:
    """读取随应用发布的固定协议元数据，缺失时不猜测兼容版本。"""
    path = Path(__file__).resolve().parents[4] / "contracts" / "dsh-runtime.json"
    return fields(json.loads(path.read_text(encoding="utf-8")))

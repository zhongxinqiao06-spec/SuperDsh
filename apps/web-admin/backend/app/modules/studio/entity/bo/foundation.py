"""作品基础纯方法：稳定兼容身份、规范哈希与精确工程时间。"""

import hashlib
import json
from functools import lru_cache
from math import lcm
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel, Field


def stable_id(scope: str, source: str) -> str:
    """导入和重试得到同一身份，不依赖目录顺序或当前时间。"""
    return uuid5(NAMESPACE_URL, f"superdsh/studio/{scope}/{source}").hex


def content_hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class CreationDefaults(BaseModel):
    """产品默认规格启动校验，禁止无效时间基准进入新工程。"""

    aspectWidth: int = Field(ge=1, le=100)
    aspectHeight: int = Field(ge=1, le=100)
    targetDurationMs: int = Field(ge=1000, le=3600000)
    language: str
    fpsNumerator: int = Field(ge=1)
    fpsDenominator: int = Field(ge=1)
    audioSampleRate: int = Field(ge=1)


@lru_cache(maxsize=1)
def creation_defaults() -> CreationDefaults:
    path = Path(__file__).resolve().parents[5] / "resources" / "studio" / "defaults.json"
    return CreationDefaults.model_validate_json(path.read_text(encoding="utf-8"))


def defaults() -> dict[str, object]:
    """普通创作默认值来自产品资源，与真实供应商密钥配置无关。"""
    return creation_defaults().model_dump()


def timebase() -> tuple[int, int, int, int]:
    config = creation_defaults()
    return (
        lcm(1000, config.fpsNumerator, config.audioSampleRate),
        config.fpsNumerator,
        config.fpsDenominator,
        config.audioSampleRate,
    )

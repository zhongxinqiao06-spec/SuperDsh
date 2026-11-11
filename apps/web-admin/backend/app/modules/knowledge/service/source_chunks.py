"""可追溯来源与稀疏文本索引，向量返回值不能替代授权原文。"""

import hashlib
import math
import re
import unicodedata
from typing import cast


def sparse_vector(text: str) -> dict[str, list[int] | list[float]]:
    """中文双字词与英文词构造归一化稀疏特征，和语义向量融合。"""
    terms = re.findall(r"[a-z0-9]+|[\u3400-\u9fff]+", unicodedata.normalize("NFKC", text).lower())
    counts: dict[int, int] = {}
    for word in terms:
        chunks = (
            [word]
            if len(word) < 2 or word.isascii()
            else [word[index : index + 2] for index in range(len(word) - 1)]
        )
        for chunk in chunks:
            key = int.from_bytes(hashlib.sha256(chunk.encode()).digest()[:4], "little")
            counts[key] = counts.get(key, 0) + 1
    weights = [(key, 1 + math.log(value)) for key, value in sorted(counts.items())]
    norm = math.sqrt(sum(value**2 for _, value in weights)) or 1
    return {
        "indices": [key for key, _ in weights],
        "values": [value / norm for _, value in weights],
    }


def source_chunks(asset: dict[str, object]) -> list[dict[str, object]]:
    """来源身份绑定资产摘要、分段和文本；修改内容会得到新的 sourceId。"""
    result: list[dict[str, object]] = []
    segments = cast(list[dict[str, object]], asset.get("segments", []))
    for index, segment in enumerate(segments):
        text = str(segment.get("content", ""))
        for offset in range(0, len(text), 800):
            content = text[offset : offset + 900].strip()
            if not content or not sparse_vector(content)["indices"]:
                continue
            location = dict(cast(dict[str, object], segment.get("location", {})))
            if offset and location:
                location["offset"] = offset
            identity = f"{asset['id']}:{asset['sha256']}:{index}:{offset}:{content}"
            result.append(
                {
                    "sourceId": "src_" + hashlib.sha256(identity.encode()).hexdigest()[:32],
                    "assetId": asset["id"],
                    "filename": asset["name"],
                    "sha256": asset["sha256"],
                    "paragraph": location.get("paragraph", 0),
                    "location": location,
                    "content": content,
                }
            )
    return result

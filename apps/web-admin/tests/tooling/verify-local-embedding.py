"""显式验证固定本地语义模型真实推理，不属于默认离线单元测试入口。"""

import asyncio
import json
import os
from pathlib import Path

from app.modules.knowledge.service.embedding_service import LOCAL_PROFILE, EmbeddingService
from app.modules.models.service.provider_transport import ProviderTransport


async def verify() -> None:
    """模型只下载到本轮验证目录，退出后由统一 runner 删除文件和进程缓存。"""
    root = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    repository = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    if not root.is_relative_to(repository / ".superdsh-work" / "web-admin-validation"):
        raise RuntimeError("验证目录不属于专用工作区")
    embedding = EmbeddingService(LOCAL_PROFILE, root / "local-embedding", ProviderTransport())
    await embedding.prepare_local()
    await embedding.ready()
    documents = await embedding.embed(
        ["差旅报销需要发票，审批后五个工作日付款。", "太阳系中的行星围绕太阳运行。"], "document"
    )
    query = (await embedding.embed(["出差费用怎么报销？"], "query"))[0]
    scores = [
        sum(left * right for left, right in zip(query, value, strict=True)) for value in documents
    ]
    assert len(query) == LOCAL_PROFILE["dimensions"] and scores[0] > scores[1], scores
    print(
        json.dumps(
            {
                "localEmbedding": "passed",
                "dimensions": len(query),
                "relatedScore": round(scores[0], 4),
                "unrelatedScore": round(scores[1], 4),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(verify())

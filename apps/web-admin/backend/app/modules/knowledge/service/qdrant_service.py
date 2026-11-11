"""Qdrant 混合索引端口；所有查询显式绑定账号和资料范围。"""

from typing import cast
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.infrastructure.errors import DomainError
from app.modules.knowledge.service.embedding_service import EmbeddingService, embedding_generation
from app.modules.knowledge.service.source_chunks import source_chunks, sparse_vector


class QdrantService:
    """客户端可注入测试 transport；生产地址来自部署配置，不接受浏览器覆盖。"""

    def __init__(
        self, origin: str, api_key: str = "", transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.origin, self.api_key, self.transport = origin.rstrip("/"), api_key, transport

    async def request(
        self,
        path: str,
        body: dict[str, object] | None = None,
        method: str = "POST",
        allowed: tuple[int, ...] = (),
    ) -> dict[str, object]:
        """请求有超时和响应大小上限，错误不泄漏部署地址或 API Key。"""
        if not self.origin:
            raise DomainError(503, "知识库 Qdrant 尚未配置")
        try:
            async with httpx.AsyncClient(
                transport=self.transport,
                timeout=httpx.Timeout(20, connect=5),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    method,
                    self.origin + path,
                    json=body,
                    headers={"api-key": self.api_key} if self.api_key else {},
                ) as response:
                    if response.status_code in allowed:
                        return {"httpStatus": response.status_code}
                    response.raise_for_status()
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > 16 * 1024 * 1024:
                            raise DomainError(502, "索引服务返回数据过大")
                    value = httpx.Response(200, content=bytes(content)).json()
                    if not isinstance(value, dict):
                        raise ValueError("invalid index response")
                    return value
        except (httpx.HTTPError, ValueError) as error:
            raise DomainError(503, "知识库 Qdrant 暂不可用，资料原文已保留，请重试") from error

    @staticmethod
    def collection(embedding: EmbeddingService) -> str:
        """代际隔离保证切换配置失败时旧索引仍然有效。"""
        return "superdsh_knowledge_hybrid_" + embedding_generation(embedding.profile)

    async def prepare(self, embedding: EmbeddingService) -> str:
        """显式检查服务和向量规格，创建竞争允许另一个实例先完成。"""
        collection = self.collection(embedding)
        value = await self.request("/collections/" + collection, method="GET", allowed=(404,))
        if value.get("httpStatus") == 404:
            await self.request(
                "/collections/" + collection,
                {
                    "vectors": {
                        "semantic": {"size": embedding.profile["dimensions"], "distance": "Cosine"}
                    },
                    "sparse_vectors": {"text": {}},
                },
                "PUT",
                (409,),
            )
        for field in ("ownerId", "assetId", "sha256"):
            await self.request(
                f"/collections/{collection}/index?wait=true",
                {"field_name": field, "field_schema": "keyword"},
                "PUT",
            )
        return collection

    async def index(self, owner: str, asset: dict[str, object], embedding: EmbeddingService) -> int:
        """同一摘要的点身份确定，重试替换同一批点而不是重复插入。"""
        collection = await self.prepare(embedding)
        chunks = source_chunks(asset)
        if not chunks:
            raise DomainError(422, "资料没有可检索正文")
        for offset in range(0, len(chunks), 24):
            batch = chunks[offset : offset + 24]
            vectors = await embedding.embed([str(item["content"]) for item in batch], "document")
            points = [
                {
                    "id": str(uuid5(NAMESPACE_URL, owner + ":" + str(item["sourceId"]))),
                    "vector": {"semantic": vector, "text": sparse_vector(str(item["content"]))},
                    "payload": {
                        "ownerId": owner,
                        "assetId": asset["id"],
                        "sha256": asset["sha256"],
                        "sourceId": item["sourceId"],
                    },
                }
                for item, vector in zip(batch, vectors, strict=True)
            ]
            await self.request(
                f"/collections/{collection}/points?wait=true", {"points": points}, "PUT"
            )
        return len(chunks)

    async def search(
        self, owner: str, assets: list[dict[str, object]], query: str, embedding: EmbeddingService
    ) -> list[dict[str, object]]:
        """混合结果重新映射授权原文，拒绝伪造 payload、旧摘要及跨账号数据。"""
        if not assets or not sparse_vector(query)["indices"]:
            return []
        semantic = (await embedding.embed([query], "query"))[0]
        condition: dict[str, object] = {
            "must": [
                {"key": "ownerId", "match": {"value": owner}},
                {"key": "assetId", "match": {"any": [item["id"] for item in assets]}},
            ]
        }
        body: dict[str, object] = {
            "prefetch": [
                {
                    "query": sparse_vector(query),
                    "using": "text",
                    "filter": condition,
                    "limit": 32,
                    "score_threshold": 0.000001,
                },
                {
                    "query": semantic,
                    "using": "semantic",
                    "filter": condition,
                    "limit": 32,
                    "score_threshold": 0.46,
                },
            ],
            "query": {"fusion": "rrf"},
            "filter": condition,
            "limit": 8,
            "with_payload": True,
            "with_vector": False,
        }
        value = await self.request(f"/collections/{self.collection(embedding)}/points/query", body)
        result = value.get("result")
        points = result.get("points", []) if isinstance(result, dict) else []
        originals = {item["sourceId"]: item for asset in assets for item in source_chunks(asset)}
        seen: set[str] = set()
        sources: list[dict[str, object]] = []
        for point in cast(list[dict[str, object]], points):
            payload = point.get("payload")
            if not isinstance(payload, dict):
                continue
            source = originals.get(payload.get("sourceId"))
            if (
                not source
                or payload.get("ownerId") != owner
                or payload.get("assetId") != source["assetId"]
                or payload.get("sha256") != source["sha256"]
                or str(source["sourceId"]) in seen
            ):
                continue
            seen.add(str(source["sourceId"]))
            sources.append(source)
        return sources

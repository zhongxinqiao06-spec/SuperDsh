"""第二阶段模型、智能体、知识库端到端测试：真实临时 PostgreSQL，受控外部服务。"""

import asyncio
import base64
import io
import json
from dataclasses import replace
from pathlib import Path
from typing import cast

import httpx
import pytest
from conftest import bootstrap, complete_initial_login
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text

from app.infrastructure.errors import DomainError
from app.modules.knowledge.service.document_parser import parse_document
from app.modules.knowledge.service.embedding_service import EmbeddingService, normalized_vectors
from app.modules.knowledge.service.qdrant_service import QdrantService
from app.modules.models.service.provider_transport import ProviderTransport


def provider_body() -> dict[str, object]:
    """所有凭据与模型名称都是合成值，不调用真实账号。"""
    return {
        "name": "受控供应商",
        "protocol": "openai-completions",
        "baseUrl": "https://models.synthetic.invalid/api",
        "apiKey": "synthetic-secret-only",
        "models": [
            {
                "modelId": "synthetic-chat",
                "name": "合成聊天",
                "contextWindow": 32000,
                "maxTokens": 1024,
                "inputTypes": ["text", "image"],
            }
        ],
        "enabled": True,
    }


async def test_provider_secret_scope_default_and_configuration_projection(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    body = provider_body()
    created = await client.post("/api/admin/models/providers", json=body)
    assert created.status_code == 200, created.text
    provider = created.json()
    identifier = provider["providerId"]
    assert provider["apiKeyConfigured"] and "synthetic-secret-only" not in created.text
    async with app.state.database.engine.connect() as connection:
        ciphertext = await connection.scalar(
            text("SELECT credential FROM model_providers WHERE id=:id"), {"id": identifier}
        )
        assert ciphertext and "synthetic-secret-only" not in ciphertext
    catalog = (await client.get("/api/admin/models/configurations")).json()
    config = next(item for item in catalog["configurations"] if item["connectionId"] == identifier)
    assert config["parameters"]["contextWindow"] == 32000
    selected = {"selection": {"providerId": identifier, "modelId": "synthetic-chat"}}
    assert (await client.put("/api/admin/models/default", json=selected)).status_code == 200
    assert (
        await client.patch(
            "/api/admin/models/providers/" + identifier, json={**body, "enabled": False}
        )
    ).status_code == 422
    preserved = await client.patch(
        "/api/admin/models/providers/" + identifier, json={**body, "apiKey": ""}
    )
    assert preserved.status_code == 200
    assert (
        await app.state.services.models.resolve(
            account, identifier, "openai-completions", "synthetic-chat"
        )
    )["key"] == "synthetic-secret-only"
    personal = await client.post(
        "/api/models/personal/providers", json={**body, "name": "本人模型"}
    )
    assert personal.status_code == 200
    personal_id = personal.json()["providerId"]
    with pytest.raises(DomainError):
        await app.state.services.models.resolve(
            replace(account, user_id="another-owner"),
            personal_id,
            "openai-completions",
            "synthetic-chat",
        )
    assert (await client.delete("/api/admin/models/providers/" + personal_id)).status_code == 404
    assert (await client.delete("/api/admin/models/providers/" + identifier)).status_code == 200
    assert (await client.get("/api/admin/models/default")).json()["selection"] is None
    assert (await client.get("/api/models/catalog")).json()["providers"][0][
        "providerId"
    ] == personal_id


async def test_model_revision_roles_parameters_and_injected_network(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    connection = (
        await client.post(
            "/api/admin/models/connections",
            json={
                "name": "合成连接",
                "adapter": "openai-completions",
                "baseUrl": "https://models.synthetic.invalid",
                "apiKey": "fixture-key",
            },
        )
    ).json()
    assert connection["credentialConfigured"]
    payload = {
        "name": "图像能力",
        "connectionId": connection["id"],
        "capability": "image.generate",
        "modelId": "synthetic-image",
        "enabled": True,
        "parameters": {"size": "1024x1024"},
        "roleIds": [],
    }
    response = await client.post("/api/admin/models/configurations", json=payload)
    assert response.status_code == 200, response.text
    config = response.json()
    updates = await asyncio.gather(
        *[
            client.patch(
                "/api/admin/models/configurations/" + config["id"],
                json={**payload, "revision": 1, "name": name},
            )
            for name in ("编辑一", "编辑二")
        ]
    )
    assert sorted(item.status_code for item in updates) == [200, 409]
    assert (
        await client.patch(
            "/api/admin/models/connections/" + connection["id"],
            json={
                "name": "改地址",
                "adapter": "openai-completions",
                "baseUrl": "https://other.synthetic.invalid",
                "revision": connection["revision"],
            },
        )
    ).status_code == 409
    assert (
        await client.post(
            "/api/admin/models/configurations", json={**payload, "roleIds": ["nonexistent-role"]}
        )
    ).status_code == 422
    assert (
        await client.post(
            "/api/admin/models/configurations",
            json={**payload, "parameters": {"size": "unbounded"}},
        )
    ).status_code == 422
    observed: list[httpx.Request] = []

    def success(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        return httpx.Response(200, json={"data": []})

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(success)
    )
    assert (
        await client.post("/api/admin/models/configurations/" + config["id"] + "/verify")
    ).status_code == 200
    assert observed[0].headers["authorization"] == "Bearer fixture-key"

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    app.state.services.model_configurations.transport = ProviderTransport(
        transport=httpx.MockTransport(timeout)
    )
    assert (
        await client.post("/api/admin/models/configurations/" + config["id"] + "/verify")
    ).status_code == 504
    assert (await client.get("/api/models/operations/not-owned")).status_code == 404
    current = (await client.get("/api/admin/models/configurations")).json()
    assert current["configurations"][0]["revision"] == 2
    assert account.user_id


def office_bytes(kind: str) -> tuple[str, bytes, str]:
    """内存生成真实 Office/PDF 文件，过程不写生产源码。"""
    stream = io.BytesIO()
    if kind == "docx":
        from docx import Document

        document = Document()
        document.add_paragraph("真实知识段落 Alpha")
        document.save(stream)
        return "资料.docx", stream.getvalue(), "paragraph"
    if kind == "xlsx":
        from openpyxl import Workbook

        workbook = Workbook()
        sheet = workbook.active
        assert sheet is not None
        sheet.title = "销售"
        sheet.append(["区域", "金额"])
        sheet.append(["华东", 120])
        workbook.save(stream)
        workbook.close()
        return "资料.xlsx", stream.getvalue(), "sheet"
    if kind == "pptx":
        from pptx import Presentation

        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[0])
        title = slide.shapes.title
        assert title is not None
        title.text = "演示资料 Alpha"
        presentation.save(stream)
        return "资料.pptx", stream.getvalue(), "page"
    from reportlab.pdfgen.canvas import Canvas

    canvas = Canvas(stream)
    canvas.drawString(72, 720, "Knowledge Alpha on physical page one")
    canvas.showPage()
    canvas.save()
    return "资料.pdf", stream.getvalue(), "page"


@pytest.mark.parametrize("kind", ["docx", "xlsx", "pptx", "pdf"])
def test_real_document_parsers_preserve_locations(kind: str) -> None:
    name, content, location = office_bytes(kind)
    parsed = parse_document(name, content)
    assert parsed.text and parsed.segments
    assert location in cast(dict[str, object], parsed.segments[0]["location"])


def test_parser_rejects_corruption_empty_scan_and_invalid_vectors() -> None:
    for name, content in [
        ("broken.docx", b"not zip"),
        ("broken.pdf", b"bad pdf"),
        ("unknown.exe", b"MZ"),
        ("empty.txt", b"   "),
    ]:
        with pytest.raises(DomainError):
            parse_document(name, content)
    for vectors in ([[0, 0]], [[float("nan"), 1]], [[1]], [[True, 1]]):
        with pytest.raises(DomainError):
            normalized_vectors(vectors, 1, 2)


async def upload_text(client: AsyncClient, name: str = "公司制度.md") -> str:
    """合成文本含真实可定位的中文段落。"""
    response = await client.post(
        "/api/admin/agents/assets",
        json={
            "name": name,
            "kind": "knowledge",
            "contentBase64": base64.b64encode(
                "# 报销制度\n差旅报销需要发票，审批后五个工作日付款。\n".encode()
            ).decode(),
        },
    )
    assert response.status_code == 201, response.text
    return str(response.json()["asset"]["id"])


async def test_agent_assets_bindings_revisions_and_publishing(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    asset = await upload_text(client)
    assert await upload_text(client) == asset
    assert (
        await client.post(
            "/api/admin/agents/assets",
            json={"name": "../secret.md", "kind": "knowledge", "contentBase64": "YQ=="},
        )
    ).status_code == 422
    assert (
        await client.post(
            "/api/admin/agents/assets",
            json={"name": "test.md", "kind": "knowledge", "contentBase64": "YQ==\n"},
        )
    ).status_code == 422
    base_response = await client.post(
        "/api/admin/knowledge-bases",
        json={"name": "公司知识", "assetIds": [asset], "enabled": True},
    )
    assert base_response.status_code == 201, base_response.text
    base = base_response.json()["knowledgeBase"]
    body = {
        "name": "知识助手",
        "instructions": "仅使用绑定资料回答",
        "published": True,
        "knowledgeBaseIds": [base["id"]],
        "knowledgeAssetIds": [],
        "templateAssetIds": [],
        "skillIds": [],
        "toolIds": [],
    }
    response = await client.post("/api/admin/agents", json=body)
    assert response.status_code == 201, response.text
    agent = response.json()["agent"]
    assert (await client.get("/api/admin/agents/" + agent["id"] + "/readiness")).json()["ready"]
    assert (
        await client.put("/api/admin/agents/" + agent["id"], json={**body, "version": 99})
    ).status_code == 409
    assert (
        await client.post(
            "/api/admin/agents",
            json={**body, "skillPolicy": {"mode": "fixed", "fixedSkillId": "unknown"}},
        )
    ).status_code == 422
    binding = await app.state.services.resources.bind(
        account, "synthetic-knowledge-session", agent["id"]
    )
    bound = await app.state.services.agents.assets.execution_assets(account, binding.id, True)
    assert bound[0]["id"] == asset and bound[0]["segments"]
    with pytest.raises(DomainError):
        await app.state.services.agents.assets.remove(account, asset)
    assert (await client.delete("/api/admin/knowledge-bases/" + base["id"])).status_code == 409
    assert (
        await client.put(
            "/api/admin/knowledge-bases/" + base["id"],
            json={"name": base["name"], "assetIds": [asset], "enabled": False, "version": 1},
        )
    ).status_code == 200
    with pytest.raises(DomainError):
        await app.state.services.agents.assets.execution_assets(account, binding.id, True)


class ControlledEmbedding(EmbeddingService):
    """测试只验证检索协议和持久状态；不声称受控向量是真实模型质量。"""

    def __init__(self, directory: Path) -> None:
        super().__init__(
            {
                "id": "synthetic",
                "kind": "local",
                "model": "fixture-model",
                "revision": "fixture-revision",
                "dimensions": 3,
            },
            directory,
            ProviderTransport(),
        )
        self.failure = False

    async def ready(self) -> None:
        if self.failure:
            raise DomainError(503, "合成编码器依赖失败")

    async def embed(self, texts: list[str], purpose: str) -> list[list[float]]:
        await self.ready()
        return [[1.0, 0.0, 0.0] for _ in texts]


class ControlledQdrant:
    """受控响应刻意掺入越权 payload，验证服务重新对照授权原文。"""

    def __init__(self) -> None:
        self.collections: set[str] = set()
        self.points: dict[str, dict[str, object]] = {}

    def request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        if request.method == "GET":
            return httpx.Response(
                200 if path == "/collections" or path in self.collections else 404,
                json={"result": {}},
            )
        if request.method == "PUT" and path.endswith("/points"):
            for point in body["points"]:
                self.points[point["id"]] = point
        elif request.method == "PUT" and not path.endswith("/index"):
            self.collections.add(path)
        if path.endswith("/points/query"):
            assert body["filter"]["must"][0]["key"] == "ownerId"
            values = [
                {"payload": cast(dict[str, object], point["payload"])}
                for point in self.points.values()
            ]
            if values:
                values.insert(0, {"payload": {**values[0]["payload"], "ownerId": "foreign-owner"}})
                values.append({"payload": {**values[-1]["payload"], "sha256": "tampered"}})
            return httpx.Response(200, json={"result": {"points": values}})
        return httpx.Response(200, json={"result": {"status": "completed"}})


async def test_knowledge_index_failure_retry_sources_restore_and_restart(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    service = app.state.services.knowledge
    controlled = ControlledEmbedding(Path(app.state.settings.data_dir) / "synthetic-embedding")

    async def current() -> EmbeddingService:
        return controlled

    monkeypatch.setattr(service.profiles, "current", current)
    fake = ControlledQdrant()
    qdrant = QdrantService("http://synthetic-qdrant", transport=httpx.MockTransport(fake.request))
    service.qdrant, service.indexes.qdrant = qdrant, qdrant
    asset = await upload_text(client)
    base = (
        await client.post(
            "/api/admin/knowledge-bases", json={"name": "合成知识库", "assetIds": [asset]}
        )
    ).json()["knowledgeBase"]
    path = "/api/admin/knowledge-bases/" + base["id"]
    controlled.failure = True
    assert (await client.post(path + "/index", json={})).status_code == 503
    states = (await client.get(path + "/index")).json()["items"]
    assert states[0]["state"] == "failed" and "依赖失败" in states[0]["message"]
    controlled.failure = False
    response = await client.post(path + "/index", json={})
    assert response.status_code == 200, response.text
    assert response.json()["chunks"] >= 2
    found = await client.post(path + "/search", json={"query": "差旅如何报销"})
    assert found.status_code == 200, found.text
    sources = found.json()["sources"]
    assert sources and all(
        item["assetId"] == asset and item["location"].get("line") for item in sources
    )
    assert len({item["sourceId"] for item in sources}) == len(sources)
    assert (
        await client.post(path + "/index", json={"assetId": "foreign-asset"})
    ).status_code == 404
    updated = await client.put(path, json={"name": "新版知识库", "assetIds": [asset], "version": 1})
    assert updated.status_code == 200
    assert (
        await client.post(path + "/restore", json={"sourceVersion": 1, "version": 1})
    ).status_code == 409
    restored = await client.post(path + "/restore", json={"sourceVersion": 1, "version": 2})
    assert restored.status_code == 200 and restored.json()["resource"]["version"] == 3
    async with app.state.database.engine.begin() as connection:
        await connection.execute(
            text(
                "UPDATE knowledge_documents SET state='indexing', updated_at=now()-interval '10 minutes'"
            )
        )
    await service.initialize()
    assert (await client.get(path + "/index")).json()["items"][0]["state"] == "failed"


async def test_public_agent_assets_do_not_grant_management_and_duplicate_upload_is_clean(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    owner = await app.state.services.identity.authenticate(str(login["accessToken"]))
    uploaded = await asyncio.gather(
        upload_text(client, "并发资料.md"), upload_text(client, "并发资料.md")
    )
    assert uploaded[0] == uploaded[1]
    assert (await app.state.services.files.list_entries(owner, {"search": "并发资料.md"}))[
        "total"
    ] == 1
    response = await client.post(
        "/api/admin/users",
        json={
            "username": "synthetic-member",
            "password": "Synthetic-password-234!",
            "displayName": "合成普通用户",
            "roles": ["member"],
        },
    )
    assert response.status_code == 201, response.text
    await complete_initial_login(client, "synthetic-member", "Synthetic-password-234!")
    member = await app.state.services.identity.get_account(response.json()["userId"])
    body = {
        "name": "公开资料助手",
        "instructions": "仅查询资料",
        "published": True,
        "knowledgeAssetIds": [uploaded[0]],
    }
    agent = (await client.post("/api/admin/agents", json=body)).json()["agent"]
    bundle = await app.state.services.agents.resolve_binding(member, agent["id"])
    assert bundle["resourceOwnerId"] == owner.user_id and bundle["assets"][0]["id"] == uploaded[0]
    binding = await app.state.services.resources.bind(
        member, "synthetic-member-session", agent["id"]
    )
    content, asset = await app.state.services.agents.assets.execution_content(
        member, binding.id, uploaded[0]
    )
    assert "报销" in content.decode() and asset["id"] == uploaded[0]
    with pytest.raises(DomainError):
        await app.state.services.agents.assets.content(member, uploaded[0])
    assert (
        await client.put(
            "/api/admin/agents/" + agent["id"], json={**body, "published": False, "version": 1}
        )
    ).status_code == 200
    with pytest.raises(DomainError):
        await app.state.services.agents.assets.execution_content(member, binding.id, uploaded[0])


async def test_embedding_change_rolls_back_failure_and_keeps_key_private(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    service = app.state.services.knowledge
    await upload_text(client)
    fake = ControlledQdrant()
    service.indexes.qdrant = QdrantService(
        "http://synthetic-qdrant", transport=httpx.MockTransport(fake.request)
    )

    def build(profile: dict[str, object], credential: str | None) -> EmbeddingService:
        result = ControlledEmbedding(Path(app.state.settings.data_dir) / "synthetic-model")
        result.profile = profile
        result.failure = profile.get("model") == "broken-model"
        result.trusted_origins = {"https://embed.synthetic.invalid"}
        return result

    monkeypatch.setattr(service.profiles, "build", build)
    body = {
        "kind": "openai-compatible",
        "version": 0,
        "baseUrl": "https://embed.synthetic.invalid/api",
        "model": "broken-model",
        "revision": "fixture-revision",
        "dimensions": 3,
        "apiKey": "synthetic-embedding-key",
    }
    assert (await client.put("/api/admin/knowledge-embedding", json=body)).status_code == 503
    assert (await client.get("/api/admin/knowledge-embedding")).json()["version"] == 0
    response = await client.put(
        "/api/admin/knowledge-embedding", json={**body, "model": "working-model"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 1 and response.json()["profile"]["apiKeyConfigured"]
    assert "synthetic-embedding-key" not in response.text
    assert (
        await client.put("/api/admin/knowledge-embedding", json={**body, "model": "working-model"})
    ).status_code == 409
    assert (
        await client.put(
            "/api/admin/knowledge-embedding",
            json={
                **body,
                "version": 1,
                "model": "working-model",
                "baseUrl": "https://untrusted.invalid/api",
            },
        )
    ).status_code == 403
    assert (await client.get("/api/admin/knowledge-embedding")).json()["version"] == 1


async def test_cancelled_index_has_persistent_failed_receipt(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    asset_id = await upload_text(client)
    asset = await app.state.services.agents.assets.get(account, asset_id, True)
    index = app.state.services.knowledge.indexes
    started = asyncio.Event()

    async def suspended(
        owner: str, document: dict[str, object], embedding: EmbeddingService
    ) -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    monkeypatch.setattr(index.qdrant, "index", suspended)
    embedding = ControlledEmbedding(Path(app.state.settings.data_dir) / "synthetic-model")
    task = asyncio.create_task(index.index(account.user_id, [asset], embedding))
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await index.statuses(account.user_id, [asset], embedding)
    assert (
        result[0]["state"] == "failed"
        and result[0]["operationId"]
        and "取消" in result[0]["message"]
    )

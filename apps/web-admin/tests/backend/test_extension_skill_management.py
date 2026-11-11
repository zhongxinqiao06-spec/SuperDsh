"""真实扩展安装、MCP协议和技能管理验证；包、Home、接收器全部隔离。"""

import asyncio
import base64
import io
import json
import os
import socket
import sys
import zipfile
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from conftest import bootstrap
from fastapi import FastAPI

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.mcp_client import McpClient
from app.modules.extensions.service.process import (
    run_process,
    stop_process,
    tool_environment,
)

ROOT = Path(__file__).resolve().parents[4]
MCP_FIXTURE = ROOT / "apps/web-admin/tests/fixtures/extensions/mcp_server.py"


def work_directory() -> Path:
    """所有包构建、解释器、锁文件与进程Home都位于本轮验证目录。"""
    path = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / ("extension-" + uuid4().hex)
    path.mkdir(parents=True)
    return path


def archive(files: Mapping[str, bytes | str]) -> bytes:
    """在内存构造合成ZIP，测试不会写生产资源。"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as result:
        for name, content in files.items():
            result.writestr(name, content)
    return output.getvalue()


def declaration(identifier: str, runtime: str, version: str = "1.0.0") -> dict[str, object]:
    return {
        "id": identifier,
        "name": "Synthetic extension",
        "description": "Controlled fixture",
        "version": version,
        "license": "MIT",
        "runtime": runtime,
        "entrypoint": "main.py" if runtime == "python" else "main.cjs",
        "tools": [
            {
                "id": "echo",
                "name": "Synthetic echo",
                "description": "Controlled invocation",
                "mode": "action",
                "permissions": ["sessions.run"],
                "timeoutSeconds": 5,
                "inputSchema": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
                "configurationSchema": {
                    "type": "object",
                    "properties": {"token": {"type": "string", "writeOnly": True}},
                    "required": ["token"],
                    "additionalProperties": False,
                },
                "artifactTypes": [],
            }
        ],
    }


async def install(client: httpx.AsyncClient, data: bytes, **extra: object) -> httpx.Response:
    return await client.post(
        "/api/admin/extensions/install",
        json={
            "contentBase64": base64.b64encode(data).decode(),
            **extra,
        },
    )


async def node_package(identifier: str, version: str = "1.0.0", healthy: bool = True) -> bytes:
    """npm ci 使用本地锁定依赖，执行结果证明实际加载依赖而非空安装检查。"""
    manifest = declaration(identifier, "node", version)
    main = """
const dep = require('synthetic-dependency')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', value => input += value)
process.stdin.on('end', () => {
  const body = JSON.parse(input)
  process.stdout.write(JSON.stringify(body.operation === 'health' ? {ok: HEALTHY} : {echo:body.arguments.value,dependency:dep,configured:body.settings.token==='synthetic-secret'}))
})
""".replace("HEALTHY", "true" if healthy else "false")
    package = {
        "name": identifier,
        "version": version,
        "dependencies": {"synthetic-dependency": "file:deps/synthetic"},
    }
    lock = {
        "name": identifier,
        "version": version,
        "lockfileVersion": 3,
        "requires": True,
        "packages": {
            "": package,
            "node_modules/synthetic-dependency": {
                "resolved": "deps/synthetic",
                "link": True,
            },
            "deps/synthetic": {"name": "synthetic-dependency", "version": "1.0.0"},
        },
    }
    return archive(
        {
            "superdsh-extension.json": json.dumps(manifest),
            "main.cjs": main,
            "package.json": json.dumps(package),
            "package-lock.json": json.dumps(lock),
            "deps/synthetic/package.json": json.dumps(
                {"name": "synthetic-dependency", "version": "1.0.0", "main": "index.js"}
            ),
            "deps/synthetic/index.js": "module.exports = 'locked-local-dependency'",
        }
    )


async def test_node_package_locked_install_secret_rollback_and_cas(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    identifier = "synthetic-node"
    first = await install(client, await node_package(identifier))
    assert first.status_code == 201, first.text
    reference = {
        "sourceId": identifier,
        "version": "1.0.0",
        "digest": first.json()["digest"],
        "toolId": "echo",
    }
    created = await client.post(
        "/api/admin/tools",
        json={
            "name": "Synthetic echo",
            "implementation": reference,
            "settings": {"token": "synthetic-secret"},
        },
    )
    assert created.status_code == 201, created.text
    tool = created.json()["tool"]
    assert tool["settings"] == {} and tool["configuredSecrets"] == ["token"]
    result = await app.state.services.extensions.execute(
        account, reference, {"value": "hello"}, {"token": "synthetic-secret"}, {}
    )
    assert result == {
        "echo": "hello",
        "dependency": "locked-local-dependency",
        "configured": True,
    }
    broken = await install(
        client, await node_package(identifier, "1.1.0", healthy=False), revision=1
    )
    assert broken.status_code == 422, broken.text
    current = next(
        row
        for row in (await client.get("/api/admin/extensions")).json()["items"]
        if row["id"] == identifier
    )
    assert current["activeVersion"] == "1.0.0"
    installed = await install(client, await node_package(identifier, "1.1.0"), revision=1)
    assert installed.status_code == 201, installed.text
    assert (
        await client.put(
            "/api/admin/extensions/" + identifier,
            json={"revision": 1, "enabled": True, "version": "1.0.0"},
        )
    ).status_code == 409
    assert (
        await client.put(
            "/api/admin/extensions/" + identifier,
            json={"revision": 2, "enabled": True, "version": "1.0.0"},
        )
    ).status_code == 200
    changed = await install(
        client, await node_package(identifier, "1.1.0", healthy=False), revision=3
    )
    assert changed.status_code in {409, 422}
    still = await app.state.services.extensions.execute(
        account, reference, {"value": "old"}, {"token": "synthetic-secret"}, {}
    )
    assert still["dependency"] == "locked-local-dependency"
    assert (
        await client.put(
            "/api/admin/extensions/" + identifier,
            json={"revision": 3, "enabled": False, "version": "1.0.0"},
        )
    ).status_code == 200
    with pytest.raises(DomainError) as disabled:
        await app.state.services.extensions.execute(
            account, reference, {"value": "blocked"}, {}, {}
        )
    assert disabled.value.status == 403


async def test_python_extension_real_locked_environment_and_bad_archives(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    work = work_directory()
    manifest = declaration("synthetic-python", "python")
    pyproject = '[project]\nname = "synthetic-python"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = []\n[tool.uv]\npackage = false\n'
    (work / "pyproject.toml").write_text(pyproject, encoding="utf-8")
    await run_process(
        [
            app.state.services.extensions.installer.uv,
            "lock",
            "--offline",
            "--python",
            sys.executable,
        ],
        work,
    )
    data = archive(
        {
            "superdsh-extension.json": json.dumps(manifest),
            "pyproject.toml": pyproject,
            "uv.lock": (work / "uv.lock").read_bytes(),
            "main.py": 'import json,sys\nvalue=json.load(sys.stdin)\nprint(json.dumps({"ok":True} if value["operation"]=="health" else {"echo":value["arguments"]["value"],"venv":sys.prefix!=sys.base_prefix}))\n',
        }
    )
    installed = await install(client, data)
    assert installed.status_code == 201, installed.text
    result = await app.state.services.extensions.execute(
        account,
        {
            "sourceId": manifest["id"],
            "version": manifest["version"],
            "digest": installed.json()["digest"],
            "toolId": "echo",
        },
        {"value": "python"},
        {"token": "synthetic-secret"},
        {},
    )
    assert result == {"echo": "python", "venv": True}
    for files in (
        {"../escape.py": "bad"},
        {"node_modules/cache": "bad"},
        {"CON.txt": "bad"},
    ):
        assert (await install(client, archive(files))).status_code == 422
    missing_lock = archive(
        {
            "superdsh-extension.json": json.dumps({**manifest, "id": "missing-lock"}),
            "main.py": "pass",
            "pyproject.toml": pyproject,
        }
    )
    assert (await install(client, missing_lock)).status_code == 422


async def test_mcp_stdio_real_discovery_call_error_and_schema_revocation() -> None:
    client = McpClient()
    async with client.connect(
        command=[sys.executable, str(MCP_FIXTURE)], directory=work_directory()
    ) as session:
        descriptor = next(tool for tool in await client.discover(session) if tool["id"] == "echo")
        result = await client.call(session, descriptor, {"value": "fixture"})
        assert result["structuredContent"] == {"echo": "fixture"}
        with pytest.raises(DomainError) as failure:
            await client.call(session, descriptor, {"value": "fail"})
        assert failure.value.status == 502 and "private-error" not in failure.value.detail
        await session.call_tool("mutate", {})
        with pytest.raises(DomainError) as changed:
            await client.call(session, descriptor, {"value": "fixture"})
        assert changed.value.status == 409


@asynccontextmanager
async def http_receiver() -> AsyncIterator[str]:
    """仅启动本测试持有的随机端口，退出必回收，不触碰用户开发服务。"""
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = int(reserved.getsockname()[1])
    directory = work_directory()
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(MCP_FIXTURE),
        str(port),
        cwd=directory,
        env=tool_environment(directory),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        creationflags=0x08000000 if os.name == "nt" else 0,
        start_new_session=os.name != "nt",
    )
    origin = f"http://127.0.0.1:{port}"
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=1) as client:
            async with asyncio.timeout(10):
                while True:
                    try:
                        if (await client.get(origin + "/ready")).status_code == 200:
                            break
                    except httpx.HTTPError:
                        if process.returncode is not None:
                            raise RuntimeError("controlled receiver stopped") from None
                    await asyncio.sleep(0.1)
        yield origin
    finally:
        await stop_process(process)


async def test_mcp_http_discovery_selection_credentials_and_schema_change(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    async with http_receiver() as origin:
        app.state.services.extensions.mcp.allowed_origins = origin
        body = {"endpoint": origin + "/mcp", "token": "synthetic-mcp-token"}
        discovery = await client.post("/api/admin/extensions/mcp/discover", json=body)
        assert discovery.status_code == 200, discovery.text
        selected = {
            **body,
            "id": "synthetic-mcp",
            "name": "Controlled MCP",
            "version": "1.0.0",
            "selectedToolIds": ["echo"],
            "discoveryDigest": discovery.json()["discoveryDigest"],
        }
        connected = await client.post("/api/admin/extensions/mcp", json=selected)
        assert connected.status_code == 201, connected.text
        listing = (await client.get("/api/admin/extensions")).json()["items"]
        assert "synthetic-mcp-token" not in json.dumps(listing)
        source = next(row for row in listing if row["id"] == "synthetic-mcp")
        assert source["credentialConfigured"] and len(source["tools"]) == 1
        reference = {
            "sourceId": source["id"],
            "version": source["activeVersion"],
            "digest": source["versions"][0]["digest"],
            "toolId": "echo",
        }
        answer = await app.state.services.extensions.execute(
            account, reference, {"value": "HTTP"}, {}, {}
        )
        assert answer["structuredContent"] == {"echo": "HTTP"}
        async with httpx.AsyncClient(trust_env=False) as remote:
            assert (await remote.post(origin + "/control")).status_code == 200
        with pytest.raises(DomainError) as changed:
            await app.state.services.extensions.execute(
                account, reference, {"value": "HTTP"}, {}, {}
            )
        assert changed.value.status == 409
        check = await client.post("/api/admin/extensions/synthetic-mcp/check", json={})
        assert check.status_code == 200 and check.json()["status"] == "needs-review"
        with pytest.raises(DomainError):
            await app.state.services.extensions.bind(account, reference)


def skill_body(name: str, referenced: str | None = None) -> dict[str, object]:
    """程序以通用阶段和授权组成，测试不依赖Office名称。"""
    body: dict[str, object] = {
        "name": name,
        "instructions": "Use supplied facts",
        "requiredToolIds": [],
    }
    if referenced:
        body["programDraft"] = {
            "stages": [
                {
                    "id": "reference",
                    "name": "Reference",
                    "instructions": "Use child skill",
                    "operation": "submit",
                    "skillId": referenced,
                }
            ]
        }
    return body


async def test_skill_cycles_are_atomic_during_edit_and_restore(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    _app, client = platform
    await bootstrap(client)
    a = (await client.post("/api/admin/skills", json=skill_body("A"))).json()["skill"]
    b = (await client.post("/api/admin/skills", json=skill_body("B", a["id"]))).json()["skill"]
    cleared = await client.put(
        "/api/admin/skills/" + b["id"],
        json={**skill_body("B"), "version": 1, "programDraft": None},
    )
    assert cleared.status_code == 200, cleared.text
    updated = await client.put(
        "/api/admin/skills/" + a["id"], json={**skill_body("A", b["id"]), "version": 1}
    )
    assert updated.status_code == 200, updated.text
    restored = await client.post(
        "/api/admin/skills/" + b["id"] + "/restore",
        json={"version": 2, "sourceVersion": 1},
    )
    assert restored.status_code == 422, restored.text
    c = (await client.post("/api/admin/skills", json=skill_body("C"))).json()["skill"]
    d = (await client.post("/api/admin/skills", json=skill_body("D"))).json()["skill"]
    concurrent = await asyncio.gather(
        client.put(
            "/api/admin/skills/" + c["id"],
            json={**skill_body("C", d["id"]), "version": 1},
        ),
        client.put(
            "/api/admin/skills/" + d["id"],
            json={**skill_body("D", c["id"]), "version": 1},
        ),
    )
    assert sorted(row.status_code for row in concurrent) == [200, 422]


async def test_skill_archive_publish_matching_and_asset_compensation(
    platform: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = platform
    login = await bootstrap(client)
    account = await app.state.services.identity.authenticate(str(login["accessToken"]))
    data = archive(
        {
            "SKILL.md": "---\nname: Synthetic skill\ndescription: Controlled import\nrequiredToolIds: []\n---\nUse only these synthetic facts.",
            "references/fixture.csv": "item,value\na,1\n",
        }
    )
    response = await client.post(
        "/api/admin/skills/import",
        json={"contentBase64": base64.b64encode(data).decode()},
    )
    assert response.status_code == 201, response.text
    skill = response.json()["skill"]
    assert len(skill["references"]) == 1 and len(skill["packageSha256"]) == 64
    draft = {
        "stages": [
            {
                "id": "draft",
                "name": "Draft",
                "instructions": "Use verified sources",
                "operation": "submit",
            }
        ],
        "match": {
            "phrases": ["report"],
            "excludePhrases": ["skip"],
            "inputExtensions": [".csv"],
        },
    }
    update = await client.put(
        "/api/admin/skills/" + skill["id"],
        json={
            **skill_body("Synthetic skill"),
            "version": 1,
            "programDraft": draft,
        },
    )
    assert update.status_code == 200, update.text
    published = await client.post(
        "/api/admin/skills/" + skill["id"] + "/publish", json={"version": 2}
    )
    assert published.status_code == 200, published.text
    assert published.json()["skill"]["programDraft"] is None
    assert len(published.json()["skill"]["references"]) == 1
    matched = await client.post(
        "/api/admin/skills/match-preview",
        json={"request": "report", "extensions": [".csv"], "skillIds": [skill["id"]]},
    )
    assert matched.json()["candidates"][0]["score"] == 10
    excluded = await client.post(
        "/api/admin/skills/match-preview",
        json={"request": "skip report", "skillIds": [skill["id"]]},
    )
    assert excluded.json()["candidates"][0]["score"] == -1
    assets = app.state.services.skill_management.assets
    before = len(await assets.list(account))
    failed_package = archive(
        {
            "SKILL.md": "---\nname: Bad import\ndescription: Controlled rollback\nrequiredToolIds: [missing-tool]\n---\nDo not execute.",
            "references/new.csv": "item,value\nunique," + uuid4().hex,
        }
    )
    failed = await client.post(
        "/api/admin/skills/import",
        json={"contentBase64": base64.b64encode(failed_package).decode()},
    )
    assert failed.status_code == 422, failed.text
    assert len(await assets.list(account)) == before
    bad_yaml = archive(
        {"SKILL.md": "---\nname: First\nname: Second\ndescription: duplicate\n---\nWrong."}
    )
    assert (
        await client.post(
            "/api/admin/skills/import",
            json={"contentBase64": base64.b64encode(bad_yaml).decode()},
        )
    ).status_code == 422

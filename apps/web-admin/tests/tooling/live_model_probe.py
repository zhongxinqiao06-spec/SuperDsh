"""显式执行真实模型验收；凭据仅在内存中使用，测试账号与会话独立。"""

from __future__ import annotations

import asyncio
import json
import secrets
import sys
import time
from pathlib import Path
from typing import NotRequired, TypedDict, cast
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[4]
OUTPUT = ROOT / ".superdsh-work/web-admin-validation/live-models-20261109"


class ProbeResult(TypedDict):
    """单次真实会话的脱敏结果，不保存请求凭据。"""

    model: str
    sessionId: str
    status: str
    agentBound: bool


class ProbeCleanup(TypedDict, total=False):
    """分别记录进程停止与账号撤销，异常仅保留类型。"""

    runtimeStopped: bool
    runtimeError: str
    userDisabled: bool
    userError: str


class ProbeEvidence(TypedDict):
    """探测证据有明确结构，可在中途失败时保存已完成部分。"""

    externalModels: bool
    results: list[ProbeResult]
    cleanup: ProbeCleanup
    userId: NotRequired[str]
    username: NotRequired[str]
    default: NotRequired[dict[str, object]]
    runtime: NotRequired[dict[str, str]]
    permission: NotRequired[dict[str, object]]
    completed: NotRequired[bool]


def record(value: object) -> dict[str, object]:
    """收敛 JSON 对象边界；不把未经检查的动态响应当作业务形状。"""
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("expected a JSON object")
    return cast(dict[str, object], value)


def records(value: object) -> list[dict[str, object]]:
    """逐项验证响应数组，禁止通过宽泛 Any 跳过类型检查。"""
    if not isinstance(value, list):
        raise ValueError("expected a JSON object array")
    return [record(item) for item in value]


def string(value: object) -> str:
    """验证文本字段，错误不回显字段内容。"""
    if not isinstance(value, str):
        raise ValueError("expected a JSON string")
    return value


async def write_evidence(path: Path, value: object) -> None:
    """验证输出写入独立目录，不在事件循环阻塞文件操作。"""
    await asyncio.to_thread(
        path.write_text, json.dumps(value, ensure_ascii=False, indent=2), "utf-8"
    )


async def request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    json: dict[str, object] | None = None,
) -> dict[str, object]:
    """错误只输出状态和稳定错误码，不回显可能携带凭据的请求或上游正文。"""
    response = await client.request(method, path, json=json)
    if response.is_error:
        try:
            payload = record(response.json())
            code = string(payload.get("code", "request_failed"))
            detail = payload.get("detail") if path.startswith("/sessions/") else None
        except ValueError:
            code = "non_json_error"
            detail = None
        safe_detail = detail[:300] if isinstance(detail, str) else ""
        raise RuntimeError(f"{method} {path}: HTTP {response.status_code}, {code} {safe_detail}")
    return record(response.json()) if response.content else {}


async def login(client: httpx.AsyncClient, username: str, password: str) -> None:
    """新建探测账号按正式首次改密流程登录，不绕过服务端 resetRequired 门禁。"""
    result = await request(
        client,
        "POST",
        "/auth/login",
        json={"identifier": username, "password": password, "clientName": "真实模型隔离验证"},
    )
    client.headers["Authorization"] = "Bearer " + string(result["accessToken"])
    if result.get("resetRequired"):
        if not username.startswith("model_probe_"):
            raise RuntimeError("管理员需要自行完成首次改密，探测不能替用户修改密码")
        await request(client, "POST", "/auth/change-password", json={"newPassword": password})
        result = await request(
            client,
            "POST",
            "/auth/login",
            json={"identifier": username, "password": password, "clientName": "真实模型隔离验证"},
        )
        if result.get("resetRequired"):
            raise RuntimeError("临时账号首次改密未完成")
        client.headers["Authorization"] = "Bearer " + string(result["accessToken"])


async def complete(
    client: httpx.AsyncClient, identifier: str
) -> tuple[dict[str, object], dict[str, object]]:
    """只有已提交的完成事件和助手回复共同存在，才记作模型执行成功。"""
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        snapshot = await request(client, "GET", f"/sessions/{identifier}/snapshot")
        session = record(snapshot["session"])
        # HTTP events 是断线恢复快照，不重放 turn_ended；完成序列来自已提交的结束事件。
        ended = session.get("latestTurnEndSeq", 0)
        if isinstance(ended, int) and ended > 0 and session["status"] in {"idle", "error"}:
            native = await request(client, "GET", f"/runtime/sessions/{identifier}")
            return snapshot, native
        await asyncio.sleep(1)
    raise RuntimeError("native model turn timed out; no automatic resend")


async def run(*, bind_agent: bool = True) -> None:
    """仅用户授权时运行；可覆盖绑定助手或不绑定业务智能体的通用对话。"""
    await asyncio.to_thread(OUTPUT.mkdir, parents=True, exist_ok=True)
    config = record(
        json.loads(
            await asyncio.to_thread(
                (ROOT / ".superdsh-work/web-admin-dev/config/settings.json").read_text, "utf-8"
            )
        )
    )
    ports = record(config["ports"])
    administrator = record(config["initialAdmin"])
    base = f"http://127.0.0.1:{ports['backendPort']}/api"
    headers = {"Origin": f"http://localhost:{ports['frontedPort']}"}
    evidence: ProbeEvidence = {"externalModels": True, "results": [], "cleanup": {}}
    user_id: str | None = None
    username = "model_probe_" + uuid4().hex[:12]
    password = secrets.token_urlsafe(32)
    async with (
        httpx.AsyncClient(base_url=base, headers=headers, timeout=45, trust_env=False) as admin,
        httpx.AsyncClient(base_url=base, headers=headers, timeout=45, trust_env=False) as member,
    ):
        try:
            await login(admin, string(administrator["username"]), string(administrator["password"]))
            user = await request(
                admin,
                "POST",
                "/admin/users",
                json={
                    "username": username,
                    "password": password,
                    "roles": ["member"],
                    "displayName": "模型连接临时验证",
                },
            )
            user_id = string(user["userId"])
            evidence["userId"], evidence["username"] = user_id, username
            await write_evidence(OUTPUT / "evidence.json", evidence)
            await login(member, username, password)
            catalog = await request(member, "GET", "/models/catalog")
            default = record(catalog["default"])
            evidence["default"] = default
            assert default["modelId"] == "deepseek-flash"
            await request(member, "POST", "/server-agent")
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                agent = record((await request(member, "GET", "/server-agent"))["agent"])
                if agent["status"] == "running":
                    break
                if agent["status"] == "error":
                    raise RuntimeError(
                        "native startup error: "
                        + json.dumps(agent.get("error"), ensure_ascii=False)
                    )
                await asyncio.sleep(1)
            else:
                raise RuntimeError("native startup timed out")
            evidence["runtime"] = {
                "status": string(agent["status"]),
                "connectorId": string(agent["connectorId"]),
            }
            print("Native DSH running", flush=True)
            models = records((await request(member, "GET", "/runtime/catalogs/models"))["models"])
            permissions = records(
                (await request(member, "GET", "/runtime/catalogs/permissions"))["permissions"]
            )
            enabled_permissions = [item for item in permissions if item.get("enabled")]
            permission = next(
                (
                    item
                    for item in enabled_permissions
                    if "read" in str(item.get("label", "")).lower()
                ),
                enabled_permissions[0],
            )
            evidence["permission"] = {
                "selectionId": permission["selectionId"],
                "label": permission.get("label"),
            }
            await write_evidence(OUTPUT / "runtime-models.json", models)
            default_provider = f"superdsh-{catalog['scope']}-{default['providerId']}"
            assert any(
                record(item.get("metadata", {})).get("provider") == default_provider
                and record(item.get("metadata", {})).get("model") == "deepseek-flash"
                and item.get("enabled")
                for item in models
            ), "configured default model is not enabled in native catalog"
            ark_provider = next(
                item["providerId"]
                for item in records(catalog["providers"])
                if any(
                    model["modelId"] == "doubao-seed-2.1-pro" for model in records(item["models"])
                )
            )
            ark = next(
                item
                for item in models
                if record(item.get("metadata", {})).get("model") == "doubao-seed-2.1-pro"
                and record(item.get("metadata", {})).get("provider")
                == f"superdsh-{catalog['scope']}-{ark_provider}"
                and item.get("enabled")
            )
            binding: dict[str, object] = {}
            if bind_agent:
                published = await request(member, "GET", "/agents")
                definitions = records(published.get("agents", published.get("items", [])))
                definition = next(item for item in definitions if item["name"] == "默认助手")
                binding["agentDefinitionId"] = definition["id"]
            choices: list[tuple[str, dict[str, str]]] = [
                ("deepseek-flash", {}),
                ("doubao-seed-2.1-pro", {"model": string(ark["selectionId"])}),
            ]
            for name, selections in choices:
                result = await request(
                    member,
                    "POST",
                    "/sessions/create-and-start",
                    json={
                        "connectorId": agent["connectorId"],
                        "projectId": agent["projectId"],
                        **binding,
                        "clientMessageId": uuid4().hex,
                        "title": "模型连接临时验证",
                        "text": "这是无副作用的连接测试。请只回复 OK，不思考、不调用任何工具。",
                        "selections": {"permission": permission["selectionId"], **selections},
                    },
                )
                identifier = string(record(result["session"])["id"])
                print(f"Submitted {name}", flush=True)
                snapshot, native = await complete(member, identifier)
                # 测试输入为合成文本，证据只保存本次测试会话，不读取其他用户历史。
                await write_evidence(
                    OUTPUT / f"{name}.json",
                    {"snapshot": snapshot, "native": native},
                )
                session = record(snapshot["session"])
                entry: ProbeResult = {
                    "model": name,
                    "sessionId": identifier,
                    "status": string(session["status"]),
                    "agentBound": bool(session.get("agentDefinition")),
                }
                evidence["results"].append(entry)
                print(json.dumps(entry, ensure_ascii=False), flush=True)
                assert entry["status"] == "idle", "model turn failed; inspect isolated evidence"
                assert entry["agentBound"] is bind_agent
                assert record(native["metadata"]).get("agentPreset"), "native Agent mode is missing"
                assert record(record(native["metadata"])["lastUsedModel"])["model"] == name
                replies = [
                    item
                    for item in records(record(snapshot["timeline"])["items"])
                    if item.get("role") == "assistant" and item.get("type") == "message"
                ]
                assert replies, "missing persisted assistant reply"
                assert string(record(replies[-1]["content"])["text"]).strip() == "OK", (
                    "unexpected assistant reply"
                )
            evidence["completed"] = True
        finally:
            if user_id:
                try:
                    await request(member, "DELETE", "/server-agent")
                    stopped = record((await request(member, "GET", "/server-agent"))["agent"])
                    evidence["cleanup"]["runtimeStopped"] = stopped["status"] == "stopped"
                    await request(member, "POST", "/auth/logout", json={})
                except Exception as error:
                    evidence["cleanup"]["runtimeError"] = type(error).__name__
                try:
                    await request(admin, "DELETE", f"/admin/users/{user_id}")
                    evidence["cleanup"]["userDisabled"] = True
                except Exception as error:
                    evidence["cleanup"]["userError"] = type(error).__name__
            if "Authorization" in admin.headers:
                await request(admin, "POST", "/auth/logout", json={})
            await write_evidence(OUTPUT / "evidence.json", evidence)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception as error:
        print(f"Probe failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1) from None

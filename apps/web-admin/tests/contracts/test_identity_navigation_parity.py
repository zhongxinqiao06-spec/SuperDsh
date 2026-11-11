"""执行旧处理器与新 ASGI/用例的差分；端口使用内存，不冒充 PostgreSQL 或终端实测。"""

import json
import os
import subprocess
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from http.cookies import SimpleCookie
from pathlib import Path
from typing import cast

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr, ValidationError

from app.infrastructure.configuration import Settings
from app.infrastructure.crypto import PasswordSecurity
from app.infrastructure.errors import DomainError
from app.main import create_app
from app.modules.identity.entity.bo.models import Account, LoginSession, Role, User
from app.modules.identity.service.identity import IdentityService, Login
from app.modules.identity.service.management import AccountManagement
from app.modules.identity.service.ports import IdentityRepository, IdentityTransaction
from app.modules.models.entity.vo.model_vo import ProviderInput
from app.modules.models.service.capabilities import CAPABILITIES, validate_parameters
from app.modules.navigation.entity.bo.navigation import Navigation
from app.modules.navigation.service.navigation import NavigationService
from app.modules.navigation.service.ports import NavigationTransaction
from app.modules.navigation.service.rules import filter_items, validate_items

ROOT = Path(__file__).resolve().parents[4]
OUTPUT = Path(
    os.environ.get(
        "WEB_ADMIN_PARITY_EVIDENCE_DIR",
        ROOT / ".superdsh-work/web-admin-validation/phase-three-api",
    )
).resolve()
if not OUTPUT.is_relative_to(ROOT / ".superdsh-work/web-admin-validation"):
    raise ValueError("身份差分输出目录越界")
ACCOUNT = Account(
    "synthetic-user",
    "synthetic",
    ("member",),
    (),
    1,
    session_id="session-b",
    display_name="Synthetic",
)
SECURITY = PasswordSecurity("synthetic-parity-signing-key-at-least-32-chars")


@pytest.fixture(scope="module")
def oracle() -> dict[str, object]:
    """从只读旧包取得真实结果；Node 子进程关闭自己的临时 loopback HTTP 服务。"""
    process = subprocess.run(
        [
            "node",
            str(ROOT / "apps/web-admin/tests/parity/legacy-identity-navigation-oracle.ts"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=45,
        check=True,
        env={**os.environ, "NODE_NO_WARNINGS": "1"},
    )
    return cast(dict[str, object], json.loads(process.stdout))


@pytest.fixture(scope="module")
def evidence() -> Iterator[list[dict[str, object]]]:
    """仅保留合成输入与观察报告；不写产品数据库，不生成真实凭据。"""
    rows: list[dict[str, object]] = []
    yield rows
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "identity-navigation-evidence.json").write_text(
        json.dumps(
            {
                "kind": "real-legacy-handler-new-asgi-memory-ports",
                "runId": os.environ.get("WEB_ADMIN_PARITY_RUN_ID"),
                "externalServices": False,
                "cases": rows,
                "count": len(rows),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


class MemoryIdentity:
    """仅实现本差分实际使用的事务端口；认证令牌保持合成值。"""

    def __init__(self) -> None:
        now = datetime.now(UTC)
        self.values = {
            identifier: LoginSession(
                identifier,
                ACCOUNT.user_id,
                SECURITY.hash_token(identifier + ".refresh"),
                1,
                "Synthetic",
                now,
                now + timedelta(days=1),
            )
            for identifier in ("session-a", "session-b")
        }

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[IdentityTransaction]:
        yield cast(IdentityTransaction, self)

    async def session(self, session_id: str, *, lock: bool = False) -> LoginSession | None:
        return self.values.get(session_id)

    async def sessions(self, user_id: str) -> list[LoginSession]:
        return [value for value in self.values.values() if value.user_id == user_id]

    async def save_session(self, session: LoginSession) -> None:
        self.values[session.id] = session

    async def user(self, user_id: str) -> User | None:
        return (
            User(ACCOUNT.user_id, ACCOUNT.username, "unused", auth_version=1)
            if user_id == ACCOUNT.user_id
            else None
        )

    async def roles(self) -> list[Role]:
        return []

    async def users(self) -> list[User]:
        return []


class ProbeIdentity(IdentityService):
    """刷新与认证端口为固定合成凭据；登出保留真实生产用例及事务行为。"""

    async def authenticate(self, token: str) -> Account:
        if token != "valid-access":
            raise DomainError(401, "login session expired or revoked")
        return ACCOUNT

    async def refresh(self, token: str) -> Login:
        if token != "session-a.refresh":
            raise DomainError(401, "login session expired or revoked")
        return Login(ACCOUNT, "synthetic-access", "session-a.next")


def cookie_observation(value: str | None, canonical: bool = False) -> dict[str, object] | None:
    """仅映射声明式 ingress 的 Path；顺序、大小写和空值引号属于等价 Cookie 编码。"""
    if value is None:
        return None
    parsed = SimpleCookie(value)
    cookie = parsed["superdsh_refresh"]
    return {
        "value": cookie.value,
        "path": "/api/v2/auth" if canonical else cookie["path"],
        "httpOnly": bool(cookie["httponly"]),
        "secure": bool(cookie["secure"]),
        "sameSite": cookie["samesite"].lower(),
        "maxAge": cookie["max-age"],
    }


async def test_auth_http_differential(
    oracle: dict[str, object], evidence: list[dict[str, object]]
) -> None:
    """空 body、Origin、Cookie 及双令牌撤销通过真实路由和异常中间件验证。"""
    settings = Settings(
        database_url="postgresql+asyncpg://synthetic:synthetic@127.0.0.1:1/unused",
        redis_url="redis://127.0.0.1:1/0",
        secret=SecretStr("synthetic-parity-signing-key-at-least-32-chars"),
        encryption_key=SecretStr("A" * 43 + "="),
        data_dir=OUTPUT / "unused-runtime",
        public_origin="http://parity.invalid",
        allowed_origins=["http://parity.invalid", "http://allowed.invalid"],
    )
    app = create_app(settings)
    try:
        async with AsyncClient(
            transport=ASGITransport(app), base_url="http://parity.invalid"
        ) as client:
            for prefix in ("/api", "/api/v2"):
                for old in cast(list[dict[str, object]], oracle["auth"]):
                    case = cast(dict[str, object], old["input"])
                    repository = MemoryIdentity()
                    app.state.services.identity = ProbeIdentity(
                        cast(IdentityRepository, repository), SECURITY, ""
                    )
                    client.cookies.clear()
                    headers = {"content-type": "application/json"}
                    for field, header in (
                        ("origin", "origin"),
                        ("cookie", "cookie"),
                        ("access", "authorization"),
                    ):
                        if case.get(field):
                            value = str(case[field])
                            headers[header] = (
                                "superdsh_refresh=" + value
                                if field == "cookie"
                                else "Bearer " + value
                                if field == "access"
                                else value
                            )
                    response = await client.post(
                        prefix + str(case["route"]),
                        headers=headers,
                        content=None if case.get("emptyBody") else json.dumps(case.get("body", {})),
                    )
                    body = response.json() if response.content else None
                    # 成功响应只比较旧 fixture 提供的账号字段；新增字段不冒称旧库结构覆盖。
                    old_body = cast(dict[str, object] | None, old["body"])
                    compared_body = body
                    if old_body:
                        assert isinstance(body, dict)
                        compared_body = {
                            key: body.get(key) for key in old_body if key != "serverTime"
                        }
                    expected_body = (
                        {key: value for key, value in old_body.items() if key != "serverTime"}
                        if old_body
                        else old_body
                    )
                    actual = {
                        "status": response.status_code,
                        "body": compared_body,
                        "cookie": cookie_observation(
                            response.headers.get("set-cookie"), prefix == "/api"
                        ),
                        "revoked": sorted(
                            value.id for value in repository.values.values() if value.revoked_at
                        ),
                    }
                    expected = {
                        "status": old["status"],
                        "body": expected_body,
                        "cookie": cookie_observation(cast(str | None, old["cookie"])),
                        "revoked": old["revoked"],
                    }
                    evidence.append(
                        {
                            "scenario": case["id"],
                            "method": "POST",
                            "legacyPath": "/api/v2" + str(case["route"]),
                            "canonicalPath": "/api" + str(case["route"]),
                            "testedPath": prefix + str(case["route"]),
                            "test": "test_auth_http_differential",
                            "legacy": expected,
                            "new": actual,
                            "passed": actual == expected,
                            "scope": "actual HTTP/ASGI handlers; synthetic authentication, real new logout service; additive account fields excluded",
                        }
                    )
                    assert actual == expected, (prefix, case["id"], actual, expected)
    finally:
        await app.state.database.close()


class MemoryNavigation:
    """隔离菜单持久化，实际调用生产菜单用例。"""

    def __init__(self, items: list[dict[str, object]]) -> None:
        self.value = Navigation(1, items)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[NavigationTransaction]:
        yield self

    async def lock(self) -> None:
        pass

    async def read(self) -> Navigation:
        return self.value

    async def save(self, navigation: Navigation, actor: str | None) -> None:
        self.value = navigation


async def role_choices(account: Account) -> list[dict[str, str]]:
    return [{"id": "member", "name": "Member"}, {"id": "admin", "name": "Admin"}]


async def test_navigation_differential(
    oracle: dict[str, object], evidence: list[dict[str, object]]
) -> None:
    """逐权限、重置状态、编辑越权和字段边界均以旧函数真实结果作为预期。"""
    modules = cast(list[dict[str, object]], oracle["modules"])
    defaults = cast(list[dict[str, object]], oracle["defaults"])
    icons = cast(list[str], oracle["icons"])
    for index, case in enumerate(cast(list[dict[str, object]], oracle["visibility"])):
        account = replace(
            ACCOUNT,
            permissions=tuple(cast(list[str], case["permissions"])),
            reset_required=bool(case["resetRequired"]),
        )
        actual = filter_items(defaults, modules, account)
        evidence.append(
            {
                "scenario": f"navigation-permissions-{index}",
                "method": "GET",
                "legacyPath": "/api/v2/navigation",
                "canonicalPath": "/api/navigation",
                "test": "test_navigation_differential",
                "input": {
                    "permissions": case["permissions"],
                    "resetRequired": case["resetRequired"],
                },
                "legacy": case["items"],
                "new": actual,
                "passed": actual == case["items"],
                "scope": "real old/new menu filter, synthetic account",
            }
        )
        assert actual == case["items"]
    for case in cast(list[dict[str, object]], oracle["validation"]):
        status = 200
        try:
            validate_items(cast(list[dict[str, object]], case["items"]), modules, icons)
        except DomainError as error:
            status = error.status
        evidence.append(
            {
                "scenario": cast(dict[str, object], case["input"])["id"],
                "method": "PUT",
                "legacyPath": "/api/v2/admin/menus",
                "canonicalPath": "/api/admin/menus",
                "test": "test_navigation_differential",
                "legacy": {"status": case["status"]},
                "new": {"status": status},
                "passed": status == case["status"],
                "scope": "real old/new menu validation function; error message not normalized or asserted",
            }
        )
        assert status == case["status"], case["input"]
    for index, case in enumerate(cast(list[dict[str, object]], oracle["editChecks"])):
        repository = MemoryNavigation(deepcopy(defaults))
        service = NavigationService(repository, modules, icons, defaults, role_choices)
        status = 200
        try:
            await service.save(
                replace(ACCOUNT, permissions=tuple(cast(list[str], case["permissions"]))),
                1,
                cast(list[dict[str, object]], case["items"]),
            )
        except DomainError as error:
            status = error.status
        evidence.append(
            {
                "scenario": f"menu-edit-permission-{index}",
                "method": "PUT",
                "legacyPath": "/api/v2/admin/menus",
                "canonicalPath": "/api/admin/menus",
                "test": "test_navigation_differential",
                "input": {"page": case["id"], "permissions": case["permissions"]},
                "legacy": {"status": case["status"]},
                "new": {"status": status},
                "passed": status == case["status"],
                "scope": "old edit permission function vs new real service; memory persistence",
            }
        )
        assert status == case["status"], case


async def test_session_activity_null_and_idempotent_revoke() -> None:
    """无活动时间保持 null；刷新更新真实活动；无记录/他人记录删除均幂等不越权。"""
    repository = MemoryIdentity()
    service = IdentityService(cast(IdentityRepository, repository), SECURITY, "")
    assert all(value["lastSeenAt"] is None for value in await service.list_sessions(ACCOUNT))
    await service.refresh("session-a.refresh")
    assert repository.values["session-a"].last_seen_at is not None
    repository.values["foreign"] = replace(
        repository.values["session-a"], id="foreign", user_id="other-user"
    )
    await service.revoke_session(ACCOUNT, "missing")
    await service.revoke_session(ACCOUNT, "foreign")
    assert repository.values["foreign"].revoked_at is None
    await service.revoke_session(ACCOUNT, "session-b")
    await service.revoke_session(ACCOUNT, "session-b")
    assert repository.values["session-b"].revoked_at is not None


@pytest.fixture(scope="module")
def management_oracle() -> dict[str, object]:
    """管理旧处理器使用合成 SQL 端口，模型验证直接执行旧生产函数。"""
    process = subprocess.run(
        [
            "node",
            str(ROOT / "apps/web-admin/tests/parity/legacy-management-model-oracle.ts"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=45,
        check=True,
        env={**os.environ, "NODE_NO_WARNINGS": "1"},
    )
    return cast(dict[str, object], json.loads(process.stdout))


class MemoryManagement(MemoryIdentity):
    """角色用例真实执行读写及归属保护，持久化与事务锁以隔离端口替换。"""

    def __init__(self, roles: list[dict[str, object]], actor: Account, assigned: bool) -> None:
        super().__init__()
        self.actor = actor
        self.role_values = {
            str(row["id"]): Role(
                str(row["id"]),
                str(row["name"]),
                str(row["description"]),
                json.loads(str(row["permissions_json"])),
                bool(row["builtin"]),
            )
            for row in roles
        }
        self.role_values["admin"].permissions = list(actor.permissions)
        self.assigned = assigned

    async def lock(self) -> None:
        pass

    async def roles(self) -> list[Role]:
        return sorted(self.role_values.values(), key=lambda role: role.id)

    async def user(self, user_id: str) -> User | None:
        return (
            User(
                self.actor.user_id,
                self.actor.username,
                "unused",
                ["admin"],
                auth_version=1,
            )
            if user_id == self.actor.user_id
            else None
        )

    async def users(self) -> list[User]:
        return [User("assigned-user", "assigned", "unused", ["custom"])] if self.assigned else []

    async def save_role(self, role: Role) -> None:
        self.role_values[role.id] = role

    async def delete_role(self, role_id: str) -> None:
        del self.role_values[role_id]

    async def audit(
        self, actor: str | None, action: str, target: str, detail: dict[str, object]
    ) -> None:
        pass


class ManagementProbeIdentity(IdentityService):
    def __init__(self, repository: MemoryManagement, actor: Account) -> None:
        super().__init__(cast(IdentityRepository, repository), SECURITY, "")
        self.actor = actor

    async def authenticate(self, token: str) -> Account:
        return self.actor


def role_observation(body: object, created: bool) -> object:
    """不比较服务端生成的不透明 ID；新增 revision 单独由并发测试覆盖。"""
    if not isinstance(body, dict):
        return body
    result = {str(key): value for key, value in body.items() if key != "revision"}
    if created and "id" in result:
        result["id"] = "<generated-role-id>"
    if "roles" in result:
        result["roles"] = [
            role_observation(value, False) for value in cast(list[object], result["roles"])
        ]
    if "permissions" in result and isinstance(result["permissions"], list):
        result["permissions"] = [
            {"id": value["id"]} if isinstance(value, dict) else value
            for value in result["permissions"]
        ]
    return result


async def test_role_http_differential(
    management_oracle: dict[str, object], evidence: list[dict[str, object]]
) -> None:
    """角色正向 CRUD、权限上限、内置/引用保护与校验边界逐入口执行。"""
    settings = Settings(
        database_url="postgresql+asyncpg://synthetic:synthetic@127.0.0.1:1/unused",
        redis_url="redis://127.0.0.1:1/0",
        secret=SecretStr("synthetic-parity-signing-key-at-least-32-chars"),
        encryption_key=SecretStr("A" * 43 + "="),
        data_dir=OUTPUT / "unused-runtime",
    )
    app = create_app(settings)
    permissions = cast(dict[str, str], management_oracle["permissions"])
    try:
        async with AsyncClient(
            transport=ASGITransport(app),
            base_url="http://parity.invalid",
            headers={"Authorization": "Bearer synthetic"},
        ) as client:
            for prefix in ("/api", "/api/v2"):
                for case in cast(list[dict[str, object]], management_oracle["management"]):
                    entry = cast(dict[str, object], case["input"])
                    actor = Account(
                        "synthetic-admin",
                        "synthetic",
                        ("admin",),
                        tuple(cast(list[str], entry.get("grants", list(permissions)))),
                        1,
                    )
                    repository = MemoryManagement(
                        cast(list[dict[str, object]], management_oracle["roleFixtures"]),
                        actor,
                        bool(entry.get("assigned")),
                    )
                    app.state.services.identity = ManagementProbeIdentity(repository, actor)
                    app.state.services.management = AccountManagement(
                        cast(IdentityRepository, repository), SECURITY
                    )
                    response = await client.request(
                        str(entry["method"]),
                        prefix + str(entry["route"]),
                        json=entry.get("body"),
                    )
                    created = entry["method"] == "POST"
                    # 错误文案语言差异保留原始证据；授权语义以状态码及不发生写入为准。
                    actual_body = response.json() if response.content else None
                    actual = {
                        "status": response.status_code,
                        "body": role_observation(actual_body, created)
                        if response.status_code < 400
                        else None,
                    }
                    expected = {
                        "status": case["status"],
                        "body": role_observation(case["body"], created)
                        if int(str(case["status"])) < 400
                        else None,
                    }
                    evidence.append(
                        {
                            "scenario": entry["id"],
                            "method": entry["method"],
                            "legacyPath": "/api/v2" + str(entry["route"]),
                            "canonicalPath": "/api" + str(entry["route"]),
                            "testedPath": prefix + str(entry["route"]),
                            "test": "test_role_http_differential",
                            "legacy": expected,
                            "new": actual,
                            "legacyBody": case["body"],
                            "newBody": actual_body,
                            "passed": actual == expected,
                            "scope": "real HTTP/ASGI handlers and role services; isolated SQL/DAO ports; additive revision and generated ID normalized; error detail not asserted",
                        }
                    )
                    assert actual == expected, (entry["id"], actual, expected)
    finally:
        await app.state.database.close()


def test_model_parameter_and_provider_differential(
    management_oracle: dict[str, object], evidence: list[dict[str, object]]
) -> None:
    """不发送模型请求或读取密钥，仅比较真实输入规则、默认值与能力目录。"""
    assert CAPABILITIES == management_oracle["modelCapabilities"]
    for case in cast(list[dict[str, object]], management_oracle["providers"]):
        entry = cast(dict[str, object], case["input"])
        status = 200
        value: dict[str, object] | None = None
        try:
            parsed = ProviderInput.model_validate(entry["input"])
            value = parsed.model_dump()
            value["apiKey"] = (
                parsed.apiKey.get_secret_value() if parsed.apiKey is not None else None
            )
        except ValidationError:
            status = 422
        actual = {"status": status, "value": value}
        expected = {"status": case["status"], "value": case.get("value")}
        evidence.append(
            {
                "scenario": entry["id"],
                "method": "POST",
                "legacyPath": "/api/v2/admin/models/providers",
                "canonicalPath": "/api/admin/models/providers",
                "test": "test_model_parameter_and_provider_differential",
                "legacy": expected,
                "new": actual,
                "passed": actual == expected,
                "scope": "real old provider validator/new input DTO; no persistence or model request",
            }
        )
        assert actual == expected, (entry["id"], actual, expected)
    for case in cast(list[dict[str, object]], management_oracle["parameters"]):
        entry = cast(dict[str, object], case["input"])
        status, value = 200, None
        try:
            value = validate_parameters(
                str(entry["adapter"]),
                str(entry["capability"]),
                str(entry["model"]),
                cast(dict[str, object], entry["values"]),
            )
        except DomainError as error:
            status = error.status
        actual = {"status": status, "value": value}
        expected = {"status": case["status"], "value": case.get("value")}
        evidence.append(
            {
                "scenario": case["id"],
                "method": "POST",
                "legacyPath": "/api/v2/admin/models/configurations",
                "canonicalPath": "/api/admin/models/configurations",
                "test": "test_model_parameter_and_provider_differential",
                "input": entry,
                "legacy": expected,
                "new": actual,
                "passed": actual == expected,
                "scope": "real old/new capability parameter functions; error detail not asserted; no persistence or model request",
            }
        )
        assert actual == expected, (entry, actual, expected)

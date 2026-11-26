"""使用合成凭据和本地传输验证注册邮件，覆盖供应商拒绝、权限开关和模板用途。"""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from conftest import bootstrap
from fastapi import FastAPI

from app.modules.identity.service.registration_ses import TencentRegistrationMail


def mailer() -> TencentRegistrationMail:
    return TencentRegistrationMail.model_validate(
        {
            "secretId": "synthetic-id",
            "secretKey": "synthetic-secret",
            "region": "ap-hongkong",
            "fromAddress": "sender@example.invalid",
            "templateId": 123,
        }
    )


def test_reject_malformed_file_without_exposing_secret(tmp_path: Path) -> None:
    path = tmp_path / "invalid.json"
    path.write_text('{"secretKey":"synthetic-secret"}', encoding="utf-8")
    with pytest.raises(ValueError, match="注册邮件配置无效") as error:
        TencentRegistrationMail.from_file(path)
    assert "synthetic-secret" not in str(error.value)
    assert TencentRegistrationMail.from_file(None) is None


async def test_registration_uses_only_approved_template(
    platform: tuple[FastAPI, httpx.AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    settings = app.state.services.accounts.email
    settings.registration_sender = mailer()
    assert not settings.available({}, "reset") and not settings.available({}, "bind")
    email = "ses-recipient@example.invalid"
    body = {"email": email, "purpose": "register"}
    # bootstrap 使用 Cookie 或 Bearer 登录。匿名请求验证公开注册的关闭状态。
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://localhost:5175",
        headers={"Origin": "http://localhost:5175"},
    ) as guest:
        assert (await guest.get("/api/auth/config")).json()["registrationEmailAvailable"]
        assert (await guest.post("/api/auth/email-code", json=body)).status_code == 403
        assert (
            await client.patch("/api/admin/settings", json={"registrationOpen": True})
        ).status_code == 200
        # 使用 ASGI 客户端走真正用例，仅替换公网传输；旧供应商不能在失败时接管。
        reply = httpx.Response(
            200,
            request=httpx.Request("POST", "https://example.invalid"),
            json={"Response": {"MessageId": "accepted"}},
        )
        wire = AsyncMock(return_value=reply)
        legacy = AsyncMock()
        settings.sender = legacy
        with monkeypatch.context() as patch:
            patch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", wire)
            assert (await guest.post("/api/auth/email-code", json=body)).status_code == 200
            assert wire.await_args is not None
            request = wire.await_args.args[0]
            payload = json.loads(request.content)
            code = json.loads(payload["Template"]["TemplateData"])["code"]
            assert str(request.url) == "https://ses.tencentcloudapi.com/"
            assert request.headers["X-TC-Action"] == "SendEmail"
            assert request.headers["X-TC-Region"] == "ap-hongkong"
            assert request.headers["Authorization"].startswith(
                "TC3-HMAC-SHA256 Credential=synthetic-id/"
            )
            assert payload["Template"]["TemplateID"] == 123 and payload["Destination"] == [email]
            assert payload["TriggerType"] == 1 and len(code) == 6
            user = await guest.post(
                "/api/auth/register",
                json={
                    "email": email,
                    "password": "Synthetic-password-456!",
                    "code": code,
                    "product": "office",
                },
            )
            assert user.status_code == 200 and user.json()["roles"] == ["member"]
            wire.return_value = httpx.Response(
                200,
                json={"Response": {"Error": {"Code": "AuthFailure.SignatureFailure"}}},
            )
            rejected = await guest.post(
                "/api/auth/email-code", json={**body, "email": "other@example.invalid"}
            )
            assert rejected.status_code == 502 and wire.await_count == 2
            legacy.send.assert_not_awaited()

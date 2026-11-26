"""隔离浏览器的注册邮件收件箱；验证码的生成、校验和入账使用正式服务。"""

import os
import re
from pathlib import Path

from fastapi import FastAPI

import app.main as application
from app.infrastructure.configuration import Settings
from app.launcher import main

original = application.create_app


class RegistrationInbox:
    async def send(self, configuration: dict[str, object], address: str, code: str) -> None:
        if not re.fullmatch(r"registration-[a-f0-9-]{36}@example\.invalid", address):
            raise ValueError("只接收本次测试的合成邮箱")
        directory = Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]) / "registration-mail"
        directory.mkdir(exist_ok=True)
        (directory / address).write_text(code, encoding="ascii")


def create_app(settings: Settings | None = None) -> FastAPI:
    if os.environ.get("WEB_ADMIN_E2E_LIVE") != "1":
        raise RuntimeError("仅用于独立浏览器测试")
    settings = settings or Settings()
    app = original(settings.model_copy(update={"registration_ses_file": None}))
    app.state.services.accounts.email.registration_sender = RegistrationInbox()
    return app


if __name__ == "__main__":
    application.create_app = create_app
    main()

"""腾讯云 SES 注册验证码传输。密钥由后端从私有配置读取，只签名固定的发信请求。"""

import hashlib
import hmac
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.validation import email_address

HOST = "ses.tencentcloudapi.com"


class TencentRegistrationMail(BaseModel):
    """只使用审核过的注册模板；任何校验错误都不能在日志中带出文件内容。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, hide_input_in_errors=True)
    secretId: SecretStr = Field(min_length=1)
    secretKey: SecretStr = Field(min_length=1)
    region: Literal["ap-guangzhou", "ap-hongkong"]
    templateId: int = Field(gt=0)
    fromAddress: str

    @field_validator("fromAddress")
    @classmethod
    def valid_address(cls, value: str) -> str:
        return email_address(value)

    @classmethod
    def from_file(cls, path: Path | None) -> Self | None:
        """显式配置文件缺失或无效时终止启动，避免误用另一个发信账户。"""
        if path is None:
            return None
        try:
            return cls.model_validate_json(path.read_bytes())
        except (OSError, ValidationError, DomainError):
            raise ValueError(
                "腾讯云注册邮件配置无效，请检查文件、密钥、地域、发件地址和模板"
            ) from None

    def _headers(self, body: bytes, now: datetime) -> dict[str, str]:
        # TC3 要求签名的正文和网络发送的字节完全一致，日期与时间戳取自同一 UTC 时刻。
        date, timestamp = now.strftime("%Y-%m-%d"), str(int(now.timestamp()))
        scope = f"{date}/ses/tc3_request"
        content_type = "application/json"
        signed = "content-type;host"
        canonical = (
            f"POST\n/\n\ncontent-type:{content_type}\nhost:{HOST}\n\n{signed}\n"
            + hashlib.sha256(body).hexdigest()
        )
        to_sign = (
            f"TC3-HMAC-SHA256\n{timestamp}\n{scope}\n"
            + hashlib.sha256(canonical.encode()).hexdigest()
        )
        key = ("TC3" + self.secretKey.get_secret_value()).encode()
        for part in (date, "ses", "tc3_request"):
            key = hmac.digest(key, part.encode(), "sha256")
        signature = hmac.digest(key, to_sign.encode(), "sha256").hex()
        return {
            "Authorization": (
                f"TC3-HMAC-SHA256 Credential={self.secretId.get_secret_value()}/{scope}, "
                f"SignedHeaders={signed}, Signature={signature}"
            ),
            "Content-Type": content_type,
            "X-TC-Action": "SendEmail",
            "X-TC-Version": "2020-10-02",
            "X-TC-Region": self.region,
            "X-TC-Timestamp": timestamp,
        }

    async def send(self, configuration: dict[str, object], address: str, code: str) -> None:
        """按验证码触发类投递一次；响应不明确时交回原有验证码失败处理，不重复投递。"""
        body = json.dumps(
            {
                "FromEmailAddress": self.fromAddress,
                "Destination": [address],
                "Subject": "星桥注册验证码",
                "Template": {
                    "TemplateID": self.templateId,
                    "TemplateData": json.dumps({"code": code}),
                },
                "TriggerType": 1,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"https://{HOST}/", content=body, headers=self._headers(body, datetime.now(UTC))
            )
            response.raise_for_status()
        result = response.json()["Response"]
        if "Error" in result or not result.get("MessageId"):
            error = result.get("Error", {}).get("Code")
            # 供应商文本可能含邮箱或模板参数，诊断日志只记录标准错误码。
            if isinstance(error, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9.]{0,100}", error):
                logging.getLogger("web_admin").warning("ses.send-rejected", extra={"code": error})
            raise ValueError("Tencent SES rejected registration mail")

"""本地与 S3 对象适配；有界 I/O、确定对象键，不接受客户端文件路径。"""

import asyncio
import hashlib
import hmac
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

from app.infrastructure.errors import DomainError


class ObjectStorage:
    """S3 使用标准 SigV4，无重定向，凭据只用于后端签名。"""

    def __init__(
        self, configuration: dict[str, object], credentials: dict[str, object], root: Path
    ) -> None:
        self.configuration, self.credentials, self.root = configuration, credentials, root.resolve()

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root) or path == self.root:
            raise DomainError(422, "invalid object key")
        return path

    async def _request(
        self,
        method: str,
        key: str,
        content: bytes = b"",
        media_type: str = "application/octet-stream",
    ) -> httpx.Response:
        endpoint = urlsplit(str(self.configuration.get("endpoint", "")))
        if (
            endpoint.scheme not in {"http", "https"}
            or not endpoint.netloc
            or endpoint.username
            or endpoint.password
            or endpoint.query
            or endpoint.fragment
        ):
            raise DomainError(422, "S3 地址格式不正确")
        bucket = str(self.configuration.get("bucket", ""))
        prefix = str(self.configuration.get("prefix", "")).strip("/")
        object_key = "/".join(part for part in [prefix, key] if part)
        virtual = bool(self.configuration.get("virtualHostStyle", False))
        host = f"{bucket}.{endpoint.netloc}" if virtual else endpoint.netloc
        path = quote(
            endpoint.path.rstrip("/")
            + "/"
            + (object_key if virtual else bucket + "/" + object_key),
            safe="/-_.~",
        )
        now = datetime.now(UTC)
        stamp, date = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        region = str(self.configuration.get("region", "us-east-1"))
        body_hash = hashlib.sha256(content).hexdigest()
        headers = {"host": host, "x-amz-date": stamp, "x-amz-content-sha256": body_hash}
        if self.credentials.get("sessionToken"):
            headers["x-amz-security-token"] = str(self.credentials["sessionToken"])
        names = sorted(headers)
        signed = ";".join(names)
        canonical = "\n".join(
            [
                method,
                path,
                "",
                "".join(f"{name}:{headers[name].strip()}\n" for name in names),
                signed,
                body_hash,
            ]
        )
        scope = f"{date}/{region}/s3/aws4_request"
        value = "\n".join(
            ["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()]
        )
        signing = ("AWS4" + str(self.credentials.get("secretAccessKey", ""))).encode()
        for item in [date, region, "s3", "aws4_request"]:
            signing = hmac.digest(signing, item.encode(), "sha256")
        signature = hmac.new(signing, value.encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.credentials.get('accessKeyId', '')}/{scope}, SignedHeaders={signed}, Signature={signature}"
        )
        headers["content-type"] = media_type
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(45, connect=8), follow_redirects=False
            ) as client:
                response = await client.request(
                    method, f"{endpoint.scheme}://{host}{path}", content=content, headers=headers
                )
            if response.status_code == 404:
                raise DomainError(404, "file not found")
            if not 200 <= response.status_code < 300:
                raise DomainError(503, "文件存储暂时不可用，请检查存储连接后重试")
            return response
        except httpx.HTTPError as error:
            raise DomainError(503, "文件存储连接失败或超时") from error

    async def write(self, key: str, data: bytes, media_type: str) -> None:
        """外部 I/O 不占数据库事务；调用方负责未提交对象的回收。"""
        if self.configuration.get("backend") == "s3":
            await self._request("PUT", key, data, media_type)
        else:
            path = self._path(key)
            await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(path.write_bytes, data)

    async def read(self, key: str) -> bytes:
        """读取前的所有者权限由文件用例校验。"""
        if self.configuration.get("backend") == "s3":
            return (await self._request("GET", key)).content
        try:
            return await asyncio.to_thread(self._path(key).read_bytes)
        except FileNotFoundError as error:
            raise DomainError(404, "file not found") from error

    async def remove(self, key: str) -> None:
        """只删除服务生成的对象键，不接收绝对路径。"""
        if self.configuration.get("backend") == "s3":
            try:
                await self._request("DELETE", key)
            except DomainError as error:
                if error.status != 404:
                    raise
        else:
            await asyncio.to_thread(self._path(key).unlink, missing_ok=True)

    async def check(self) -> None:
        """健康检查不写测试对象、不触碰已有文件。"""
        if self.configuration.get("backend") == "s3":
            await self._request("HEAD", "")
        else:
            await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)

"""真实隔离 MinIO 容器；镜像读取部署元数据，凭据和对象只属于本次测试。"""

import asyncio
import json
import os
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import httpx

from app.modules.files.service.object_storage import ObjectStorage


async def docker(*arguments: str) -> str:
    """隐藏子进程窗口，捕获诊断且不使用交互 shell。"""
    process = await asyncio.create_subprocess_exec(
        "docker",
        *arguments,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    stdout, stderr = await process.communicate()
    assert process.returncode == 0, stderr.decode(errors="replace")
    return stdout.decode().strip()


@asynccontextmanager
async def minio_storage() -> AsyncIterator[dict[str, object]]:
    """新建独立对象库并检查清理标签，绝不复用开发部署卷。"""
    root = (await asyncio.to_thread(Path(__file__).resolve)).parents[4]
    metadata = json.loads(
        (root / "apps/web-admin/deployment/runtime.json").read_text(encoding="utf-8")
    )
    identity = uuid4().hex
    name, access, secret = (
        "web-admin-storage-check-" + identity,
        "synthetic" + identity[:12],
        uuid4().hex + uuid4().hex,
    )
    started = False
    try:
        await docker(
            "run",
            "-d",
            "--name",
            name,
            "--label",
            "superdsh.validation=" + identity,
            "-p",
            "127.0.0.1::9000",
            "-e",
            "MINIO_ROOT_USER=" + access,
            "-e",
            "MINIO_ROOT_PASSWORD=" + secret,
            metadata["images"]["minio"],
            "server",
            "/data",
            "--address",
            ":9000",
        )
        started = True
        binding = await docker("port", name, "9000/tcp")
        endpoint = "http://" + binding
        async with httpx.AsyncClient() as client, asyncio.timeout(30):
            while True:
                try:
                    if (await client.get(endpoint + "/minio/health/ready")).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        configuration: dict[str, object] = {
            "backend": "s3",
            "endpoint": endpoint,
            "bucket": "synthetic-contract",
            "region": "us-east-1",
        }
        credentials: dict[str, object] = {
            "accessKeyId": access,
            "secretAccessKey": secret,
        }
        await ObjectStorage(
            configuration, credentials, root / ".superdsh-work/web-admin-validation"
        )._request("PUT", "")
        yield {
            "name": "隔离 S3",
            "configuration": configuration,
            "credentials": credentials,
        }
    finally:
        if started:
            label = await docker(
                "inspect",
                "--format",
                '{{index .Config.Labels "superdsh.validation"}}',
                name,
            )
            assert label == identity, "拒绝删除非本轮 MinIO 容器"
            await docker("rm", "-f", "-v", name)

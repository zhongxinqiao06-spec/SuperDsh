"""真实本地 ONNX 或受许可外部 Embedding；不使用伪向量替代语义模型。"""

import asyncio
import hashlib
import json
import math
import multiprocessing
from multiprocessing.connection import Connection
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from app.infrastructure.errors import DomainError
from app.modules.models.service.provider_transport import ProviderTransport

MANIFEST = json.loads(
    (Path(__file__).parent.parent / "entity" / "bo" / "embedding_manifest.json").read_text(
        encoding="utf-8"
    )
)
LOCAL_PROFILE: dict[str, object] = MANIFEST["profile"]


def normalized_vectors(value: object, count: int, dimensions: int) -> list[list[float]]:
    """外部响应数量、维度、有限数和非零范数逐项检查。"""
    if not isinstance(value, list) or len(value) != count:
        raise DomainError(502, "Embedding 返回向量数量不符")
    result: list[list[float]] = []
    for row in value:
        if (
            not isinstance(row, list)
            or len(row) != dimensions
            or any(
                not isinstance(number, (int, float))
                or isinstance(number, bool)
                or not math.isfinite(number)
                for number in row
            )
        ):
            raise DomainError(502, "Embedding 向量格式或维度无效")
        norm = math.sqrt(sum(float(number) ** 2 for number in row))
        if not math.isfinite(norm) or norm <= 0:
            raise DomainError(502, "Embedding 返回空向量")
        result.append([float(number) / norm for number in row])
    return result


def embedding_generation(profile: dict[str, object]) -> str:
    """同一模型修订和维度有稳定代际，模型切换不会混用旧向量。"""
    values = [
        profile.get(field, "") for field in ("kind", "model", "revision", "dimensions", "baseUrl")
    ]
    return hashlib.sha256(
        json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()[:24]


def _infer_local(directory: str, texts: list[str], purpose: str, pipe: Connection) -> None:
    # 独立进程可在超时、取消时终止，避免线程继续占用解析器或 CPU。
    try:
        import numpy as np
        import onnxruntime as ort  # type: ignore[import-untyped]  # 官方 wheel 未发布类型标记，仅在隔离推理进程使用。
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(Path(directory) / "tokenizer.json"))
        tokenizer.enable_truncation(max_length=512)
        tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        inputs = tokenizer.encode_batch(
            [
                "为这个句子生成表示以用于检索相关文章：" + text if purpose == "query" else text
                for text in texts
            ]
        )
        options = ort.SessionOptions()
        options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
        session = ort.InferenceSession(
            str(Path(directory) / "onnx" / "model_quantized.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        arrays = {
            "input_ids": np.array([item.ids for item in inputs], dtype=np.int64),
            "attention_mask": np.array([item.attention_mask for item in inputs], dtype=np.int64),
            "token_type_ids": np.array([item.type_ids for item in inputs], dtype=np.int64),
        }
        output = session.run(None, {item.name: arrays[item.name] for item in session.get_inputs()})[
            0
        ]
        pipe.send({"vectors": output[:, 0, :].tolist()})
    except Exception:
        pipe.send({"error": "本地 Embedding 执行失败，请检查模型文件与运行依赖"})
    finally:
        pipe.close()


class EmbeddingService:
    """每个配置对象固定模型参数，调用过程不会读到另一代配置。"""

    def __init__(
        self,
        profile: dict[str, object],
        directory: Path,
        transport: ProviderTransport,
        key: str = "",
        trusted_origins: str = "",
    ) -> None:
        self.profile, self.directory, self.transport, self.key = (
            dict(profile),
            directory,
            transport,
            key,
        )
        self.trusted_origins = {
            value.strip().rstrip("/") for value in trusted_origins.split(",") if value.strip()
        }
        self.semaphore = asyncio.Semaphore(2)

    def authorize_origin(self) -> None:
        """资料外发许可独立于网络地址白名单，由部署配置明确授权。"""
        if self.profile["kind"] == "local":
            return
        parsed = urlsplit(str(self.profile.get("baseUrl", "")))
        if f"{parsed.scheme}://{parsed.netloc}" not in self.trusted_origins:
            raise DomainError(403, "外部 Embedding 地址未获资料外发许可，请配置可信 origin")

    async def ready(self) -> None:
        """本地校验固定文件摘要，外部只发送合成探测文本。"""
        if self.profile["kind"] != "local":
            await self.embed(["语义索引连通性检查"], "document")
            return

        def verify() -> None:
            for item in MANIFEST["files"]:
                path = self.directory / item["path"]
                if (
                    not path.is_file()
                    or path.stat().st_size != item["size"]
                    or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]
                ):
                    raise DomainError(
                        503, "本地语义模型未准备或校验失败，请准备本地模型；资料原文已保留"
                    )

        await asyncio.to_thread(verify)

    async def prepare_local(self) -> dict[str, object]:
        """显式准备固定模型，不在普通启动或索引时静默下载运行依赖。"""
        async with self.semaphore:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60, connect=10),
                follow_redirects=True,
                max_redirects=5,
                trust_env=False,
            ) as client:
                for item in MANIFEST["files"]:
                    destination = self.directory / item["path"]
                    if (
                        destination.is_file()
                        and hashlib.sha256(
                            await asyncio.to_thread(destination.read_bytes)
                        ).hexdigest()
                        == item["sha256"]
                    ):
                        continue
                    url = (
                        "https://huggingface.co/"
                        + str(LOCAL_PROFILE["model"])
                        + "/resolve/"
                        + str(LOCAL_PROFILE["revision"])
                        + "/"
                        + item["path"]
                    )
                    temporary = destination.with_name(
                        destination.name + "." + uuid4().hex + ".download"
                    )
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        content = bytearray()
                        async with client.stream("GET", url) as response:
                            response.raise_for_status()
                            async for block in response.aiter_bytes():
                                content.extend(block)
                                if len(content) > item["size"]:
                                    raise DomainError(502, "下载模型文件大小超出固定清单")
                        if (
                            len(content) != item["size"]
                            or hashlib.sha256(content).hexdigest() != item["sha256"]
                        ):
                            raise DomainError(502, "下载模型文件完整性校验失败")
                        await asyncio.to_thread(temporary.write_bytes, content)
                        await asyncio.to_thread(temporary.replace, destination)
                    except httpx.HTTPError as error:
                        raise DomainError(503, "本地语义模型下载失败，可稍后重试") from error
                    finally:
                        temporary.unlink(missing_ok=True)
        return {"ready": True, "profile": LOCAL_PROFILE}

    async def embed(self, texts: list[str], purpose: str) -> list[list[float]]:
        """有界批量编码，网络或进程取消传播，不自动重发收费请求。"""
        if (
            not texts
            or len(texts) > 32
            or any(not text.strip() or len(text) > 2000 for text in texts)
        ):
            raise DomainError(422, "Embedding 每批支持 1–32 段，每段最多 2000 字")
        self.authorize_origin()
        dimensions = int(str(self.profile["dimensions"]))
        if self.profile["kind"] != "local":
            response = await self.transport.request(
                "POST",
                str(self.profile["baseUrl"]) + "/embeddings",
                {"Authorization": "Bearer " + self.key} if self.key else {},
                {
                    "model": self.profile["model"],
                    "input": texts,
                    "dimensions": dimensions,
                    "encoding_format": "float",
                },
            )
            data = response.get("data")
            if not isinstance(data, list) or any(
                not isinstance(item, dict) or item.get("index") != index
                for index, item in enumerate(data)
            ):
                raise DomainError(502, "Embedding 返回顺序无效")
            return normalized_vectors(
                [item.get("embedding") for item in data], len(texts), dimensions
            )
        await self.ready()
        async with self.semaphore:
            context = multiprocessing.get_context("spawn")
            parent, child = context.Pipe(duplex=False)
            process = context.Process(
                target=_infer_local, args=(str(self.directory), texts, purpose, child), daemon=True
            )
            process.start()
            child.close()
            try:
                result = await asyncio.wait_for(asyncio.to_thread(parent.recv), 60)
                if not isinstance(result, dict) or result.get("error"):
                    raise DomainError(503, "本地 Embedding 执行失败，请检查模型与运行依赖")
                return normalized_vectors(result.get("vectors"), len(texts), dimensions)
            except TimeoutError as error:
                raise DomainError(504, "Embedding 超过 60 秒，请缩小资料后重试") from error
            except (EOFError, OSError) as error:
                raise DomainError(503, "Embedding 工作进程提前退出") from error
            finally:
                if process.is_alive():
                    process.terminate()
                await asyncio.to_thread(process.join, 5)
                if process.is_alive():
                    process.kill()
                    await asyncio.to_thread(process.join, 5)
                parent.close()

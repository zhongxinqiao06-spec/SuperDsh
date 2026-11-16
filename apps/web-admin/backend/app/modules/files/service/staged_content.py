"""上传分片按序校验并合并到临时文件，大视频的内存占用与分片数无关。"""

import asyncio
import hashlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

from app.infrastructure.errors import DomainError


@dataclass(frozen=True)
class StagedContent:
    path: Path
    size: int
    digest: str
    head: bytes
    contains_null: bool

    @classmethod
    def media(cls, path: Path) -> "StagedContent":
        """读取服务生成的媒体摘要，文件路径仅由任务服务构造。"""
        with path.open("rb") as stream:
            head = stream.read(32)
            stream.seek(0)
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        return cls(path, path.stat().st_size, checksum, head, True)

    @classmethod
    def assemble(
        cls, destination: Path, parts: list[Path], size: int, expected: str
    ) -> "StagedContent":
        digest = hashlib.sha256()
        written = 0
        binary = False
        head = b""
        with destination.open("xb") as output:
            for path in parts:
                with path.open("rb") as source:
                    while chunk := source.read(256 * 1024):
                        written += len(chunk)
                        if written > size:
                            raise DomainError(422, "文件大小超过上传声明")
                        head = head or chunk[:32]
                        binary |= b"\0" in chunk
                        digest.update(chunk)
                        output.write(chunk)
        if written != size or digest.hexdigest() != expected:
            raise DomainError(422, "文件大小或 SHA-256 校验失败")
        return cls(destination, size, expected, head, binary)

    async def chunks(self) -> AsyncIterator[bytes]:
        with self.path.open("rb") as source:
            while chunk := await asyncio.to_thread(source.read, 256 * 1024):
                yield chunk

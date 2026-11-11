"""实际旧stage与新文件发布服务比较Android内联格式及内容校验，不执行模型。"""

import hashlib
import json
import subprocess
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from app.infrastructure.errors import DomainError
from app.modules.files.entity.bo.session_attachment import attachment_identity
from app.modules.files.service.file_service import FileService
from app.modules.files.service.session_attachment_service import SessionAttachmentService
from app.modules.identity.entity.bo.models import Account

ROOT = Path(__file__).resolve().parents[4]
DIGEST = hashlib.sha256(b"test").hexdigest()
INLINE: dict[str, object] = {
    "fileId": DIGEST,
    "name": "android.txt",
    "mediaType": "text/plain",
    "size": 4,
    "sha256": DIGEST,
    "contentBase64": "dGVzdA==",
}
CASES: list[list[dict[str, object]]] = [
    [INLINE],
    [{"fileId": "existing"}],
    [{**INLINE, "contentBase64": ""}],
    [{**INLINE, "contentBase64": "test!"}],
    [{**INLINE, "contentBase64": "dGVzdA"}],
    [{**INLINE, "contentBase64": "汉字=="}],
    [{**INLINE, "size": 5}],
    [{**INLINE, "sha256": "0" * 64}],
    [{**INLINE, "fileId": "artifact_test"}],
    [{**INLINE, "fileId": "preview_test"}],
    [INLINE] * 11,
]


@pytest.fixture(scope="module")
def old_stage() -> list[dict[str, object]]:
    result = subprocess.run(
        ["node", str(ROOT / "apps/web-admin/tests/parity/inline-attachment-oracle.ts")],
        input=json.dumps(CASES),
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=30,
        cwd=ROOT,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return cast(list[dict[str, object]], json.loads(result.stdout))


@pytest.mark.parametrize("index", range(len(CASES)))
async def test_inline_stage_matches_old_actual_service(
    index: int, old_stage: list[dict[str, object]]
) -> None:
    writes = 0
    files = Mock(spec=FileService)

    async def ingest(
        account: Account,
        name: str,
        data: bytes,
        media: str,
        previous: object,
        storage: object,
        permission: str,
        identifier: str,
    ) -> dict[str, object]:
        nonlocal writes
        writes += 1
        assert identifier == attachment_identity("owner", "session", DIGEST)
        assert permission == "sessions.run"
        return {
            "id": identifier,
            "name": name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "mediaType": media,
        }

    files._ingest = ingest
    files._bind = AsyncMock()
    files.read_bound = AsyncMock(
        return_value=(
            b"test",
            {
                "id": "existing",
                "name": "existing.txt",
                "mediaType": "text/plain",
                "size": 4,
                "sha256": DIGEST,
            },
        )
    )
    try:
        rows = await SessionAttachmentService(files).stage(
            Account("owner", "owner", (), ("sessions.run",), 1), "session", CASES[index]
        )
        result: dict[str, object] = {
            "status": 200,
            "writes": writes,
            "items": [
                {
                    "fileId": identifier,
                    **{key: entry[key] for key in ("name", "mediaType", "size", "sha256")},
                }
                for identifier, _, entry in rows
            ],
        }
    except DomainError as error:
        result = {"status": error.status, "detail": error.detail, "writes": writes}
    assert result == old_stage[index]


def test_inline_file_identity_is_account_and_session_scoped() -> None:
    """相同内容摘要的多个账号/会话不会碰撞全局主键，且重试映射稳定。"""
    key = attachment_identity("owner", "session", DIGEST)
    assert key == attachment_identity("owner", "session", DIGEST)
    assert key != attachment_identity("other", "session", DIGEST)
    assert key != attachment_identity("owner", "other-session", DIGEST)

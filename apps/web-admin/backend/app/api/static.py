"""主机生产模式的只读 SPA 服务，未知 API 路由不能回退为 HTML。"""

from pathlib import Path

from fastapi import APIRouter
from starlette.responses import FileResponse

from app.infrastructure.errors import DomainError


def static_router(directory: Path) -> APIRouter:
    """只允许构建目录下的真实文件，深链才回退 index.html。"""
    root = directory.resolve(strict=True)
    if not (root / "index.html").is_file():
        raise RuntimeError("静态构建缺少 index.html")
    router = APIRouter()

    @router.get("/{path:path}")
    async def resource(path: str) -> FileResponse:
        if path.split("/", 1)[0] in {"api", "ws", "health"}:
            raise DomainError(404, "not found")
        candidate = (root / path).resolve()
        if not candidate.is_relative_to(root):
            raise DomainError(404, "not found")
        if candidate.is_file():
            return FileResponse(candidate)
        if Path(path).suffix:
            raise DomainError(404, "not found")
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    return router

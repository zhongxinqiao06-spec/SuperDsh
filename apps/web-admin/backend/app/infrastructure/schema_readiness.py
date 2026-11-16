"""启动核对代码自带迁移头，避免新路由在旧结构上返回模糊的内部错误。"""

from pathlib import Path

from alembic.script import ScriptDirectory

from app.infrastructure.database import Database

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


async def require_current_schema(database: Database) -> None:
    expected = ScriptDirectory(str(MIGRATIONS)).get_current_head()
    if await database.schema_version() != expected:
        raise RuntimeError(
            "数据库结构尚未升级。开发环境请用 uv run python main.py 启动；部署请先完成数据库迁移。"
        )

"""真实模型探测的临时账号清理；仅供测试调用，不提供命令行入口或全库清理。"""

from __future__ import annotations

import asyncio
import hashlib
import re
from pathlib import Path
from uuid import UUID

from sqlalchemy import text

from app.infrastructure.database import Database

# 外部对象不能只删数据库行。本探测限定纯聊天，遇到资产或后台任务必须先人工核对。
EXTERNAL_STATE_GUARDS = (
    ("web_file_entries", "owner_id = :user_id"),
    ("web_file_uploads", "owner_id = :user_id"),
    ("web_file_migrations", "owner_id = :user_id"),
    ("web_file_cleanup", "owner_id = :user_id"),
    ("agent_assets", "owner_id = :user_id"),
    ("knowledge_documents", "owner_id = :user_id"),
    ("artifacts", "owner_id = :user_id"),
    ("extension_sources", "installed_by = :user_id"),
    ("web_terminal_bindings", "owner_id = :user_id"),
    ("web_shell_tasks", "owner_id = :user_id AND state IN ('running', 'starting', 'queued')"),
    ("skill_runs", "owner_id = :user_id AND state IN ('running', 'starting', 'queued')"),
)


def _deletions() -> tuple[tuple[str, str], ...]:
    sessions = "SELECT id FROM web_conversations WHERE owner_id = :user_id"
    connectors = "SELECT id FROM web_devices WHERE owner_id = :user_id"
    runs = "SELECT id FROM skill_runs WHERE owner_id = :user_id"
    resources = "SELECT id FROM resources WHERE owner_id = :user_id"
    return (
        # 没有 owner 字段的子表必须经其父记录确定归属，并在删除父记录之前处理。
        ("web_conversation_items", f"session_id IN ({sessions})"),
        ("web_conversation_events", f"session_id IN ({sessions})"),
        ("web_conversation_receipts", f"session_id IN ({sessions})"),
        ("web_conversation_shares", "owner_id = :user_id"),
        ("web_socket_tickets", "owner_id = :user_id"),
        ("web_conversation_cursors", "owner_id = :user_id"),
        ("web_file_references", "owner_id = :user_id"),
        ("web_tool_executions", "owner_id = :user_id"),
        ("model_operations", "owner_id = :user_id"),
        ("skill_events", f"run_id IN ({runs})"),
        ("approvals", f"run_id IN ({runs})"),
        ("operation_receipts", "owner_id = :user_id"),
        ("evidence", "owner_id = :user_id"),
        ("artifacts", "owner_id = :user_id"),
        ("skill_runs", "owner_id = :user_id"),
        ("resource_bindings", "owner_id = :user_id"),
        ("resource_versions", f"resource_id IN ({resources})"),
        ("resource_initializations", "owner_id = :user_id"),
        ("resources", "owner_id = :user_id"),
        ("web_shell_tasks", "owner_id = :user_id"),
        ("web_device_pairings", f"connector_id IN ({connectors})"),
        ("web_device_runtimes", f"connector_id IN ({connectors})"),
        ("web_conversations", "owner_id = :user_id"),
        ("web_projects", "owner_id = :user_id"),
        ("web_devices", "owner_id = :user_id"),
        ("runtime_batches", "owner = :user_id"),
        ("runtime_checkpoints", "owner = :user_id"),
        ("runtime_receipts", "owner = :user_id"),
        # 全局默认与平台模型没有此 scope/owner，不能按供应商名字或接口地址清理。
        ("model_defaults", "scope = :personal_scope"),
        ("model_providers", "owner_id = :user_id"),
        ("oauth_codes", "user_id = :user_id"),
        ("account_mobile_grants", "user_id = :user_id"),
        ("account_recovery_codes", "user_id = :user_id"),
        ("account_external_oauth_bindings", "user_id = :user_id"),
        ("auth_sessions", "user_id = :user_id"),
        # 包含管理员针对这个临时账号的创建/删除审计，不影响其他管理员操作记录。
        ("identity_audit", "actor_id = :user_id OR target_id = :user_id"),
        ("users", "id = :user_id AND username = :username"),
    )


async def cleanup_probe_user(
    database: Database, *, user_id: str, username: str, runtime_root: Path
) -> dict[str, object]:
    """清理一次已停止的纯聊天探测，返回计数和待核验的唯一运行目录。

    调用前必须保存新建账号的精确 ID/用户名，停止该账号 server-agent 并关闭测试客户端。
    不读取配置或凭据，不创建账号，不自动停进程，不删除任何文件。任一校验或删除失败
    都回滚整个数据库事务；没有模糊用户名匹配、级联清表或已删除用户的猜测恢复。
    """
    if not re.fullmatch(r"model_probe_[a-z0-9_]+", username) or len(username) > 32:
        raise ValueError("仅允许本次创建的 model_probe_ 前缀临时账号")
    if str(UUID(user_id)) != user_id:
        raise ValueError("临时账号 ID 必须是创建响应中的规范 UUID")
    if not runtime_root.is_absolute():
        raise ValueError("运行根目录必须由调用方传入绝对路径")
    if database.engine.dialect.name != "postgresql":
        raise ValueError("清理要求 PostgreSQL 运行租约检查")
    directory = (await asyncio.to_thread(runtime_root.resolve)) / hashlib.sha256(
        user_id.encode()
    ).hexdigest()
    parameters = {
        "user_id": user_id,
        "username": username,
        "personal_scope": "user:" + user_id,
    }
    removed: dict[str, int] = {}
    async with database.engine.begin() as connection:
        # 使用与监督器完全相同的锁键；短事务持锁期间不能重新启动该账号的 Host。
        lease_key = int.from_bytes(
            hashlib.sha256(f"superdsh:web-admin:runtime:{user_id}".encode()).digest()[:8],
            "big",
            signed=True,
        )
        if not await connection.scalar(
            text("SELECT pg_try_advisory_xact_lock(:lease_key)"), {"lease_key": lease_key}
        ):
            raise RuntimeError("临时账号仍有运行租约，必须先停止其 server-agent")
        if await connection.scalar(
            text("SELECT count(*) FROM runtime_execution_fences WHERE owner = :user_id"),
            parameters,
        ):
            raise RuntimeError("临时账号仍有执行 fence，不能删除运行证据")
        row = (
            (
                await connection.execute(
                    text(
                        "SELECT id, username, roles, email FROM users WHERE id = :user_id FOR UPDATE"
                    ),
                    parameters,
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None or row["username"] != username or row["roles"] != ["member"]:
            raise RuntimeError("临时账号身份或角色不符，拒绝删除")
        if row["email"] is not None:
            raise RuntimeError("探测账号不应绑定邮箱，需先核对外部身份及验证数据")
        for table, predicate in EXTERNAL_STATE_GUARDS:
            count = await connection.scalar(
                text(f"SELECT count(*) FROM {table} WHERE {predicate}"), parameters
            )
            if count:
                raise RuntimeError(f"临时账号在 {table} 存在外部对象或任务，需单独清理后重试")
        for table, predicate in _deletions():
            result = await connection.execute(
                text(f"DELETE FROM {table} WHERE {predicate}"), parameters
            )
            removed[table] = result.rowcount
        if removed["users"] != 1:
            raise RuntimeError("临时账号删除数量异常，事务必须回滚")
    # 只返回计算结果；物理删除由调用方再次核对仓库边界、重解析点和进程退出证据。
    return {
        "userId": user_id,
        "username": username,
        "removed": removed,
        "runtimeDirectory": str(directory),
        "home": str(directory / "home"),
        "workspace": str(directory / "workspace"),
        "filesystemDeleted": False,
    }

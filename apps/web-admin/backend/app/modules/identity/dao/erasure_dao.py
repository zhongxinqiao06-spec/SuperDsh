"""账号生命周期的事务入口。私有表的依赖顺序由数据库注销契约维护。"""

import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.identity.entity.do.models import UserRow


async def erase_personal_data(db: AsyncSession, account: Account) -> None:
    """重验当前身份、最后管理员和任务清单，任一步失败可整体回滚。"""
    uid = account.user_id
    args = {"uid": uid}
    await lock_transaction(db, "web-admin:identity-management")
    await lock_transaction(db, "account-erasure:" + uid)
    user = await db.get(UserRow, uid, with_for_update=True)
    if not user or user.disabled or user.deleted_at or user.auth_version != account.auth_version:
        raise DomainError(401, "登录状态已失效，请重新登录。")
    if not await db.scalar(
        text("""SELECT 1 FROM auth_sessions WHERE id=:sid AND user_id=:uid
                                AND revoked_at IS NULL AND expires_at>now() FOR UPDATE"""),
        {**args, "sid": account.session_id},
    ):
        raise DomainError(401, "登录状态已失效，请重新登录。")
    if "admin" in user.roles and not await db.scalar(
        text("""
        SELECT EXISTS (SELECT 1 FROM users WHERE id<>:uid AND roles ? 'admin'
        AND NOT disabled AND deleted_at IS NULL)"""),
        args,
    ):
        raise DomainError(409, "请先设置另一名可用管理员，再注销此账号。", "last_active_admin")
    # 归属来自数据库，外部对象定位从不接受浏览器传入。迁移中的源和目标也要纳入清单。
    manifest = dict(
        (
            await db.execute(
                text("""
        SELECT
        ARRAY(SELECT DISTINCT ARRAY[storage, obj] FROM (
            SELECT storage_id AS storage,object_key AS obj FROM web_file_entries WHERE owner_id=:uid
            UNION SELECT source_id,source_key FROM web_file_migrations WHERE owner_id=:uid
            UNION SELECT target_id,target_key FROM web_file_migrations WHERE owner_id=:uid
            UNION SELECT storage_id,object_key FROM web_file_cleanup WHERE owner_id=:uid
        ) keys WHERE NOT EXISTS (SELECT 1 FROM web_file_entries e WHERE e.owner_id<>:uid
            AND e.storage_id=keys.storage AND e.object_key=keys.obj)) AS objects,
        ARRAY(SELECT part.value FROM web_file_uploads, LATERAL json_each_text(parts) part WHERE owner_id=:uid) AS parts,
        ARRAY(SELECT id FROM studio_media_jobs WHERE owner=:uid OR project IN
          (SELECT id FROM studio_projects WHERE owner=:uid)) AS media,
        ARRAY(SELECT DISTINCT generation FROM knowledge_documents WHERE owner_id=:uid) AS generations,
        ARRAY(SELECT id FROM web_devices WHERE owner_id=:uid) AS devices
    """),
                args,
            )
        )
        .mappings()
        .one()
    )
    await db.execute(
        text(
            "INSERT INTO account_erasure_jobs(owner, manifest) VALUES (:uid, CAST(:manifest AS jsonb))"
        ),
        {**args, "manifest": json.dumps(manifest)},
    )
    if user.email:
        address = user.email.strip().lower()
        key = hashlib.sha256(address.encode()).hexdigest()
        await lock_transaction(db, "email-code:" + key)
        for purpose, owner in (("register", ""), ("bind", uid), ("reset", uid)):
            scope = hashlib.sha256(f"{address}\0{purpose}\0{owner}".encode()).hexdigest()
            await db.execute(
                text("DELETE FROM account_verification_codes WHERE scope=:scope"), {"scope": scope}
            )
        await db.execute(
            text("DELETE FROM account_verification_limits WHERE key=:key"), {"key": key}
        )
        await db.execute(
            text("""DELETE FROM account_external_oauth_states WHERE
            lower(value->>'email')=:email OR lower(value->>'verifiedEmail')=:email"""),
            {"email": address},
        )
    await db.execute(text("SELECT account_erase_private_rows(:uid)"), args)
    # 共享扩展、他人的账单和平台商品可引用原操作员。仅这些约束需要一个无法还原的空身份。
    shared = await db.scalar(
        text("""SELECT EXISTS (
        SELECT 1 FROM billing_operations WHERE actor_id=:uid UNION ALL
        SELECT 1 FROM billing_subscription_changes WHERE actor_id=:uid OR cancelled_by=:uid UNION ALL
        SELECT 1 FROM billing_plan_versions WHERE published_by=:uid OR withdrawn_by=:uid UNION ALL
        SELECT 1 FROM billing_pricing_versions WHERE actor=:uid OR published_by=:uid UNION ALL
        SELECT 1 FROM extension_sources WHERE installed_by=:uid UNION ALL
        SELECT 1 FROM studio_stage_reviews WHERE actor_id=:uid)"""),
        args,
    )
    if shared:
        user.erased, user.disabled, user.deleted_at = True, True, datetime.now(UTC)
        user.username, user.password_hash, user.roles = uuid4().hex, "!", []
        user.email = user.display_name = user.avatar_url = user.registration_product = None
        user.email_verified_at = user.created_at = None
        user.auth_version += 1
    else:
        await db.delete(user)

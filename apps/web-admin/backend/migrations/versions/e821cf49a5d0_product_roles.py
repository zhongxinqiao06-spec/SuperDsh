"""保留已发布角色 ID 和自定义授权，为超管及两个产品初始化范围化角色。"""

import json

import sqlalchemy as sa
from alembic import op

revision = "e821cf49a5d0"
down_revision = "d593ef192aae"
branch_labels = None
depends_on = None

# 迁移固定本次授予清单，不跟随未来运行时权限目录变化。
OFFICE = [
    "products.office",
    "devices.read",
    "devices.manage",
    "sessions.read",
    "sessions.run",
    "projects.read",
    "projects.manage",
    "files.read",
    "files.write",
    "terminal.use",
    "models.personal.manage",
    "models.use",
]
STUDIO = [
    "products.entertainment",
    "sessions.read",
    "sessions.run",
    "files.read",
    "files.write",
    "models.use",
]
SCOPES = {
    key: [f"products.{key}.{area}.manage" for area in ("menus", "members", "resources", "models")]
    for key in ("office", "entertainment")
}
NEW_ROLES = {
    "office_admin": ("办公管理员", OFFICE + SCOPES["office"]),
    "entertainment_admin": ("娱乐管理员", STUDIO + SCOPES["entertainment"]),
    "entertainment_creator": ("娱乐创作者", STUDIO),
}


def upgrade() -> None:
    """只为内置超管补充新授权，保留旧角色/账号绑定和经营者配置。"""
    database = op.get_bind()
    # 旧服务可能已在启动时预置部分角色。沿用原记录、修订及所有账号绑定。
    for identifier, (name, permissions) in NEW_ROLES.items():
        database.execute(
            sa.text("""
          INSERT INTO roles (id, name, description, permissions, builtin, revision)
          VALUES (:id, :name, '', CAST(:grants AS jsonb), true, 1)
          ON CONFLICT (id) DO NOTHING
        """),
            {"id": identifier, "name": name, "grants": json.dumps(permissions)},
        )
    # 成员授权依赖固定角色 ID，不能将同 ID 的自定义角色当作系统角色分配。
    conflict = database.scalar(
        sa.text("""
            SELECT id FROM roles WHERE NOT builtin AND id = ANY(CAST(:ids AS text[]))
            ORDER BY id LIMIT 1
        """),
        {"ids": list(NEW_ROLES)},
    )
    if conflict:
        raise RuntimeError(
            f"产品内置角色标识 {conflict} 已由自定义角色占用，请先核对角色及其授权绑定"
        )
    database.execute(
        sa.text("""
        UPDATE roles SET name = '办公用户', revision = revision + 1
        WHERE id = 'member' AND builtin AND name = 'member'
    """)
    )
    database.execute(
        sa.text("""
        UPDATE roles SET name = CASE WHEN name = 'admin' THEN '平台超级管理员' ELSE name END,
            permissions = (
                SELECT jsonb_agg(DISTINCT permission ORDER BY permission)
                FROM jsonb_array_elements_text(permissions || CAST(:grants AS jsonb)) AS p(permission)
            ), revision = revision + 1 WHERE id = 'admin' AND builtin
            AND (name = 'admin' OR NOT (permissions @> CAST(:grants AS jsonb)))
    """),
        {"grants": json.dumps(SCOPES["office"] + SCOPES["entertainment"])},
    )


def downgrade() -> None:
    """已分配产品角色时要求显式处理，回退不得留下悬空账号绑定或悄悄撤权。"""
    database = op.get_bind()
    if database.scalar(
        sa.text("""
        SELECT EXISTS (SELECT 1 FROM users
            WHERE roles ?| ARRAY['office_admin','entertainment_admin','entertainment_creator'])
        OR EXISTS (SELECT 1 FROM roles WHERE NOT builtin AND
            EXISTS (SELECT 1 FROM jsonb_array_elements_text(permissions) AS p(permission)
                    WHERE permission = ANY(CAST(:grants AS text[]))))
    """),
        {"grants": SCOPES["office"] + SCOPES["entertainment"]},
    ):
        raise RuntimeError("请先解除新增产品角色绑定及自定义产品管理授权再回退")
    database.execute(
        sa.text("""
        DELETE FROM roles WHERE builtin AND id IN ('office_admin','entertainment_admin','entertainment_creator')
    """)
    )
    database.execute(
        sa.text("""
        UPDATE roles SET permissions = permissions - CAST(:grants AS text[]),
        name = CASE WHEN name = '平台超级管理员' THEN 'admin' ELSE name END,
        revision = revision + 1 WHERE builtin AND id = 'admin'
    """),
        {"grants": SCOPES["office"] + SCOPES["entertainment"]},
    )
    database.execute(
        sa.text("""
        UPDATE roles SET name = 'member', revision = revision + 1
        WHERE builtin AND id = 'member' AND name = '办公用户'
    """)
    )

"""复现旧库角色先于迁移创建的情况，验证升级不会覆盖账号的授权。"""

import pytest
from conftest import upgrade_database
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.identity.entity.do.models import RoleRow, UserRow

PRODUCT_ROLES = ("office_admin", "entertainment_admin", "entertainment_creator")
MANAGEMENT = [
    f"products.{product}.{area}.manage"
    for product in ("office", "entertainment")
    for area in ("menus", "members", "resources", "models")
]
pytestmark = pytest.mark.parametrize(
    "platform_configuration",
    ["d593ef192aae"],
    indirect=True,
    ids=["before-product-roles"],
)


async def role_snapshot(connection: AsyncConnection) -> dict[str, dict]:
    rows = await connection.execute(select(RoleRow.__table__))
    return {row["id"]: dict(row) for row in rows.mappings()}


async def add_role(
    connection: AsyncConnection,
    identifier: str,
    title: str,
    grants: list[str],
    *,
    builtin: bool,
) -> None:
    await connection.execute(
        insert(RoleRow).values(
            id=identifier,
            name=title,
            description="已有角色",
            permissions=grants,
            builtin=builtin,
            revision=7,
        )
    )


@pytest.mark.parametrize(
    "preseeded",
    [(), PRODUCT_ROLES[:1], PRODUCT_ROLES],
    ids=["legacy", "partial", "preseeded"],
)
async def test_upgrade_with_existing_roles(
    platform_configuration: Settings, preseeded: tuple[str, ...]
) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    scoped = ["products.office", "products.entertainment"]
    # 全量预置时超管已经具备新权限；部分预置时沿用旧名与旧权限。
    already_current = preseeded == PRODUCT_ROLES
    admin_name = "平台超级管理员" if already_current else "admin"
    user_roles = ["report_reader", "member", *preseeded]
    try:
        async with engine.begin() as connection:
            await add_role(
                connection,
                "admin",
                admin_name,
                scoped + (MANAGEMENT if already_current else []),
                builtin=True,
            )
            await add_role(connection, "member", "member", ["products.office"], builtin=True)
            await add_role(connection, "report_reader", "报表读者", ["files.read"], builtin=False)
            for identifier in preseeded:
                await add_role(
                    connection,
                    identifier,
                    "原有产品角色",
                    ["sessions.read"],
                    builtin=True,
                )
            await connection.execute(
                insert(UserRow).values(
                    id="existing",
                    username="existing",
                    password_hash="synthetic",
                    roles=user_roles,
                    auth_version=5,
                    revision=3,
                )
            )
            before = await role_snapshot(connection)

        await upgrade_database(url)
        async with engine.connect() as connection:
            after = await role_snapshot(connection)
            assert after.keys() == {"admin", "member", "report_reader", *PRODUCT_ROLES}
            for identifier in ("report_reader", *preseeded):
                assert after[identifier] == before[identifier]
            for identifier in PRODUCT_ROLES:
                if identifier in preseeded:
                    continue
                assert after[identifier]["builtin"] and after[identifier]["revision"] == 1
                grants = after[identifier]["permissions"]
                product = "office" if identifier == "office_admin" else "entertainment"
                assert f"products.{product}" in grants
                assert set(grants).intersection(MANAGEMENT) == {
                    grant
                    for grant in MANAGEMENT
                    if identifier.endswith("_admin") and grant.startswith(f"products.{product}.")
                }
            assert after["member"]["name"] == "办公用户"
            assert after["admin"]["name"] == "平台超级管理员"
            assert set(after["admin"]["permissions"]) == set(
                scoped
                + MANAGEMENT
                + [
                    "studio.projects.read",
                    "studio.projects.write",
                    "studio.assets.read",
                    "studio.assets.write",
                ]
            )
            assert after["admin"]["revision"] == (7 if already_current else 8)

        await upgrade_database(url)
        async with engine.connect() as connection:
            assert await role_snapshot(connection) == after
            account = (
                await connection.execute(
                    select(
                        UserRow.roles,
                        UserRow.password_hash,
                        UserRow.auth_version,
                        UserRow.revision,
                    ).where(UserRow.id == "existing")
                )
            ).one()
            assert tuple(account) == (user_roles, "synthetic", 5, 3)
    finally:
        await engine.dispose()


async def test_reserved_custom_role_rolls_back(
    platform_configuration: Settings,
) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            # 碰撞在第二个角色，失败后第一个角色的补建也应回滚。
            await add_role(
                connection,
                "entertainment_admin",
                "自定义发行人员",
                ["files.read"],
                builtin=False,
            )
            await connection.execute(
                insert(UserRow).values(
                    id="reader",
                    username="reader",
                    password_hash="synthetic",
                    roles=["entertainment_admin"],
                )
            )
            before = await role_snapshot(connection)
        with pytest.raises(RuntimeError) as error:
            await upgrade_database(url)
        assert "自定义角色" in str(error.value) and "entertainment_admin" in str(error.value)
        async with engine.connect() as connection:
            assert await role_snapshot(connection) == before
            assert await connection.scalar(select(UserRow.roles).where(UserRow.id == "reader")) == [
                "entertainment_admin"
            ]
            assert (
                await connection.scalar(text("SELECT version_num FROM alembic_version"))
                == "d593ef192aae"
            )
    finally:
        await engine.dispose()

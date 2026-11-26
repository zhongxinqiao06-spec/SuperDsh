"""验证已上线的两个菜单修订向前升级，保留页级权限、自定义分组与编辑人。"""

import asyncio
import json
from copy import deepcopy
from pathlib import Path

import pytest
from conftest import upgrade_database
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import create_async_engine

from app.infrastructure.configuration import Settings
from app.modules.navigation.entity.bo.navigation import Product
from app.modules.navigation.entity.do.models import NavigationRow
from app.modules.navigation.service.catalogs import product_catalogs

MENU_CATALOG = Path(__file__).resolve().parents[2] / "backend/resources/navigation.json"


@pytest.mark.parametrize("platform_configuration", ["080dabc329f1"], indirect=True)
async def test_move_existing_product_menus(platform_configuration: Settings) -> None:
    url = platform_configuration.database_url
    engine = create_async_engine(url)
    menus = product_catalogs(json.loads(await asyncio.to_thread(MENU_CATALOG.read_text, "utf-8")))
    moved = ("access.users", "billing.subscriptions", "billing.plans", "billing.rates")
    try:
        async with engine.begin() as db:
            product: Product
            for product in menus:
                key = "global" if product == "office" else "entertainment"
                items = [
                    deepcopy(i)
                    for i in menus[product].defaults
                    if i["id"] not in {"billing.cards", "account.cards"}
                ]
                by_id = {i["id"]: i for i in items}
                for n, module in enumerate(moved, 6):
                    by_id[module].update(parentId="platform", order=n)
                by_id["access.users"].update(title="账号运营", visible=False, roleIds=["admin"])
                if key == "entertainment":
                    by_id["billing.plans"]["parentId"] = "capabilities"
                    by_id["access.menus"]["order"] = 10000
                await db.execute(
                    insert(NavigationRow).values(
                        id=key, version=7, items=items, updated_by="operator"
                    )
                )
        await upgrade_database(url)
        async with engine.connect() as db:
            rows = (await db.execute(select(NavigationRow.__table__))).mappings().all()
            assert len(rows) == 2
            for row in rows:
                assert (row["version"], row["updated_by"]) == (9, "operator")
                by_id = {i["id"]: i for i in row["items"]}
                moved_here = [m for m in moved if row["id"] == "global" or m != "billing.plans"]
                children = sorted(
                    (i for i in row["items"] if i["parentId"] == "product-management"),
                    key=lambda i: i["order"],
                )
                assert [i["id"] for i in children] == [
                    "product.members",
                    "access.menus",
                    *moved_here,
                    "billing.cards",
                ]
                assert by_id["account.cards"]["parentId"] == "account"
                assert by_id["models"]["parentId"] == "platform"
                assert by_id["access.users"]["title"] == "账号运营"
                assert not by_id["access.users"]["visible"] and by_id["access.users"][
                    "roleIds"
                ] == ["admin"]
                if row["id"] == "entertainment":
                    assert by_id["billing.plans"]["parentId"] == "capabilities"
    finally:
        await engine.dispose()

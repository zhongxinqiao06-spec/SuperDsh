"""开发故障只读诊断：不输出连接串、凭据或用户剧本，不执行迁移。"""

import argparse
import asyncio

from sqlalchemy import text

from main import load_development_environment


async def inspect(projects: bool = False) -> None:
    load_development_environment()
    from app.infrastructure.configuration import Settings
    from app.infrastructure.database import Database

    database = Database(Settings().database_url)
    try:
        async with database.engine.connect() as connection:
            print(
                "schema:", await connection.scalar(text("SELECT version_num FROM alembic_version"))
            )
            for table in (
                "studio_projects",
                "studio_stage_reviews",
                "studio_proposals",
                "studio_generation_plans",
                "studio_job_actions",
            ):
                print(
                    table,
                    bool(
                        await connection.scalar(text("SELECT to_regclass(:name)"), {"name": table})
                    ),
                )
        if projects:
            from app.main import create_app

            app = create_app(Settings())
            try:
                async with database.engine.connect() as connection:
                    rows = (
                        await connection.execute(
                            text(
                                "SELECT id, owner FROM studio_projects WHERE lifecycle <> 'archived'"
                            )
                        )
                    ).all()
                checked = 0
                for identity, owner in rows:
                    account = await app.state.services.identity.get_account(owner)
                    if "products.entertainment" not in account.permissions:
                        continue
                    state = await app.state.services.studio.preparation.state(account, identity)
                    assert len(state["stages"]) == 4
                    checked += 1
                print("stage_checks_ok:", checked)
            finally:
                await app.state.database.close()
    finally:
        await database.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--projects", action="store_true")
    asyncio.run(inspect(parser.parse_args().projects))

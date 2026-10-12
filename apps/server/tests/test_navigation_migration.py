"""Upgrade a private pre-console database without modifying account data."""

import json

from sqlalchemy import create_engine, text

from agent_server.core.navigation import MODULE_BY_ID
from agent_server.infra.db.migrations import upgrade_database


def test_v2_39_preserves_identity_devices_roles_and_login_sessions(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_SERVER_LOGIN_ALIAS", raising=False)
    path = tmp_path / "navigation-upgrade.sqlite3"
    url = f"sqlite+aiosqlite:///{path}"
    upgrade_database(db_url=url, revision="v2_38")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as conn:
            # v2_36 imports the live permission catalog on an empty DB. Model
            # a real old installation by removing only the newly added grants.
            permissions = json.loads(
                conn.execute(
                    text("SELECT permissions_json FROM roles WHERE id='admin'")
                ).scalar_one()
            )
            permissions = [
                permission
                for permission in permissions
                if not permission.startswith("menus.")
            ]
            conn.execute(
                text("UPDATE roles SET permissions_json=:permissions WHERE id='admin'"),
                {"permissions": json.dumps(permissions)},
            )
            conn.execute(
                text(
                    "INSERT INTO users (id,username,password_hash,display_name,created_at,updated_at,role,auth_version) VALUES ('owner','original-admin','SYNTHETIC-HASH','Original owner','2026-01-01','2026-01-01','admin',5)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO user_roles (user_id,role_id) VALUES ('owner','admin')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO roles (id,name,description,builtin,permissions_json,updated_at) VALUES ('custom','Custom role','Original description',0,'[\"devices.read\"]','2026-01-01')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO connectors (id,user_id,name,connector_kind,status,token_hash,token_prefix,created_at,updated_at) VALUES ('computer','owner','My computer','desktop','offline','SYNTHETIC-HASH','synthetic','2026-01-01','2026-01-01')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO auth_sessions (id,user_id,refresh_hash,auth_version,client_name,created_at,last_seen_at,expires_at) VALUES ('login','owner','SYNTHETIC-REFRESH-HASH',5,'Desktop','2026-01-01','2026-01-01','2099-01-01')"
                )
            )
            before = {
                table: conn.execute(text(f"SELECT * FROM {table}")).all()
                for table in ("users", "user_roles", "connectors", "auth_sessions")
            }
            member = conn.execute(text("SELECT * FROM roles WHERE id='member'")).one()
            custom = conn.execute(text("SELECT * FROM roles WHERE id='custom'")).one()
        upgrade_database(db_url=url)
        with engine.connect() as conn:
            for table, rows in before.items():
                assert conn.execute(text(f"SELECT * FROM {table}")).all() == rows
            assert (
                conn.execute(text("SELECT * FROM roles WHERE id='member'")).one()
                == member
            )
            assert (
                conn.execute(text("SELECT * FROM roles WHERE id='custom'")).one()
                == custom
            )
            grants = json.loads(
                conn.execute(
                    text("SELECT permissions_json FROM roles WHERE id='admin'")
                ).scalar_one()
            )
            assert set(grants) == set(permissions) | {"menus.read", "menus.manage"}
            row = conn.execute(
                text(
                    "SELECT version,items_json FROM navigation_settings WHERE id='global'"
                )
            ).one()
            assert row.version == 1
            assert {
                node["moduleId"]
                for node in json.loads(row.items_json)
                if node["kind"] == "page"
            } == MODULE_BY_ID.keys()
            assert (
                conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_39"
            )
        # Re-running initialization must not overwrite an operator's menu.
        with engine.begin() as conn:
            items = json.loads(row.items_json)
            items[0]["title"] = "Original customized group"
            conn.execute(
                text("UPDATE navigation_settings SET version=2,items_json=:items"),
                {"items": json.dumps(items)},
            )
        upgrade_database(db_url=url)
        with engine.connect() as conn:
            kept = conn.execute(
                text("SELECT version,items_json FROM navigation_settings")
            ).one()
            assert kept.version == 2 and json.loads(kept.items_json) == items
    finally:
        engine.dispose()

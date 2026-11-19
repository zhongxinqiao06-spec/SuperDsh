"""增加整剧、稳定分集、版本化全剧设定与待审编排；不改写旧作品。"""

from alembic import op

revision = "00a1d82fa733"
down_revision = "00a0c71e9f22"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE studio_series (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), brief TEXT NOT NULL DEFAULT '',
            narrative_mode TEXT NOT NULL DEFAULT 'continuous' CHECK (narrative_mode IN ('continuous','anthology')),
            planned_episodes INTEGER NOT NULL DEFAULT 6 CHECK (planned_episodes BETWEEN 1 AND 100),
            lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','archived')),
            aspect_width INTEGER, aspect_height INTEGER, target_duration_ms INTEGER,
            language TEXT, style_brief TEXT NOT NULL DEFAULT '',
            settings_revision INTEGER NOT NULL DEFAULT 1 CHECK (settings_revision > 0),
            creation_key TEXT NOT NULL, creation_hash TEXT NOT NULL,
            updated TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (id, owner), UNIQUE (owner, creation_key),
            CHECK ((aspect_width IS NULL AND aspect_height IS NULL) OR (aspect_width > 0 AND aspect_height > 0)),
            CHECK (target_duration_ms IS NULL OR target_duration_ms > 0)
        )
    """)
    op.create_index("ix_studio_series_owner", "studio_series", ["owner"])
    op.execute("""
        CREATE TABLE studio_series_setting_versions (
            series_id TEXT NOT NULL REFERENCES studio_series(id), revision INTEGER NOT NULL,
            asset_version_ids JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (series_id, revision), CHECK (jsonb_typeof(asset_version_ids) = 'array')
        )
    """)
    op.execute("""
        CREATE TABLE studio_series_episodes (
            id TEXT PRIMARY KEY, series_id TEXT NOT NULL, owner TEXT NOT NULL,
            project_id TEXT NOT NULL UNIQUE, position INTEGER NOT NULL CHECK (position > 0),
            title TEXT NOT NULL, story JSONB NOT NULL, story_revision INTEGER NOT NULL DEFAULT 1 CHECK (story_revision > 0),
            confirmed_story_revision INTEGER, confirmed_project_revision INTEGER, confirmed_script_hash TEXT,
            settings_revision INTEGER NOT NULL, target_duration_ms INTEGER NOT NULL CHECK (target_duration_ms > 0),
            locked BOOLEAN NOT NULL DEFAULT false, unlocked_export_id TEXT REFERENCES studio_media_jobs(id),
            FOREIGN KEY (series_id, owner) REFERENCES studio_series(id, owner),
            FOREIGN KEY (project_id, owner) REFERENCES studio_projects(id, owner),
            FOREIGN KEY (series_id, settings_revision) REFERENCES studio_series_setting_versions(series_id, revision),
            UNIQUE (series_id, position) DEFERRABLE INITIALLY DEFERRED
        )
    """)
    op.execute("""
        CREATE TABLE studio_series_commands (
            id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES studio_series(id),
            operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, result JSONB NOT NULL,
            UNIQUE (series_id, operation_key)
        )
    """)
    op.create_index("ix_studio_series_commands_series_id", "studio_series_commands", ["series_id"])
    op.execute("""
        CREATE TABLE studio_series_proposals (
            id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES studio_series(id),
            project_id TEXT NOT NULL REFERENCES studio_projects(id), base_revision INTEGER NOT NULL,
            original JSONB NOT NULL, suggestions JSONB NOT NULL DEFAULT '[]'::jsonb,
            instruction TEXT NOT NULL, prompt_text TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'waiting',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (state IN ('waiting','ready','applied','discarded'))
        )
    """)
    op.create_index(
        "ix_studio_series_proposals_series_id", "studio_series_proposals", ["series_id"]
    )


def downgrade() -> None:
    op.drop_table("studio_series_proposals")
    op.drop_table("studio_series_commands")
    op.drop_table("studio_series_episodes")
    op.drop_table("studio_series_setting_versions")
    op.drop_table("studio_series")

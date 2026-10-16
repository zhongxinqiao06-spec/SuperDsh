CREATE TABLE business_agent_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size BIGINT NOT NULL,
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content BYTEA NOT NULL,
  extracted_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_user_id, kind, name, sha256)
);

CREATE TABLE business_agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE business_agent_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES business_agents(id),
  binding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE business_agent_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN agent_definition_json TEXT;

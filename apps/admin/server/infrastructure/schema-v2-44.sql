CREATE TABLE agent_extension_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  active_version TEXT NOT NULL,
  status TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  diagnostic TEXT,
  installed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_extension_versions (
  source_id TEXT NOT NULL REFERENCES agent_extension_sources(id),
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  installation_path TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id,version)
);

CREATE TABLE agent_tool_secrets (
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  tool_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  encrypted_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id,tool_id,version)
);

CREATE TABLE agent_resource_versions (
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id,kind,resource_id,version)
);

CREATE TABLE agent_tool_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_session_bindings (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id,version)
);
INSERT INTO agent_session_bindings(session_id,owner_user_id,version,binding_json,created_at)
SELECT session_id,owner_user_id,1,binding_json,created_at FROM business_agent_sessions;

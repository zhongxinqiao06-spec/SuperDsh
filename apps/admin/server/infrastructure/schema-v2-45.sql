ALTER TABLE business_agent_assets ADD COLUMN file_storage_state TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE model_connections (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  base_url TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  credential_ciphertext TEXT,
  credential_identity TEXT,
  legacy_provider_id TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_configurations (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES model_connections(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  capability TEXT NOT NULL,
  model_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  roles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_configuration_versions (
  configuration_id TEXT NOT NULL REFERENCES model_configurations(id),
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(configuration_id,revision)
);

CREATE TABLE model_capability_defaults (
  capability TEXT PRIMARY KEY,
  configuration_id TEXT REFERENCES model_configurations(id),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_provider_operations (
  id TEXT PRIMARY KEY,
  tool_run_id TEXT REFERENCES agent_tool_runs(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idempotency_key TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_request_id TEXT,
  provider_task_id TEXT,
  cancel_requested_at TEXT,
  provider_cancelled_at TEXT,
  result_json TEXT,
  receipt_ciphertext TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id,session_id,idempotency_key)
);

CREATE TABLE file_storage_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  backend TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  credentials_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE file_storage_settings (
  id TEXT PRIMARY KEY,
  active_connection_id TEXT NOT NULL REFERENCES file_storage_connections(id),
  policy_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE file_objects (
  id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL REFERENCES file_storage_connections(id),
  object_key TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(storage_id,object_key)
);

CREATE TABLE file_entries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  object_id TEXT NOT NULL REFERENCES file_objects(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  previous_file_id TEXT REFERENCES file_entries(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE file_references (
  file_id TEXT NOT NULL REFERENCES file_entries(id),
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(file_id,kind,resource_id)
);

CREATE TABLE file_uploads (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  name TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_id TEXT NOT NULL REFERENCES file_storage_connections(id),
  state TEXT NOT NULL,
  file_id TEXT REFERENCES file_entries(id),
  previous_file_id TEXT REFERENCES file_entries(id),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(owner_user_id,idempotency_key)
);

CREATE TABLE file_upload_parts (
  upload_id TEXT NOT NULL REFERENCES file_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  path TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(upload_id,part_number)
);

CREATE TABLE file_legacy_mappings (
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  legacy_file_id TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES file_entries(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(kind,resource_id,legacy_file_id)
);

CREATE TABLE file_migration_items (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES file_entries(id),
  source_storage_id TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  target_storage_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(file_id,target_storage_id)
);

CREATE INDEX foundation_files_owner_date ON file_entries(owner_user_id,created_at DESC,id);
CREATE INDEX foundation_file_refs_resource ON file_references(kind,resource_id);
CREATE INDEX foundation_file_legacy_file ON file_legacy_mappings(file_id);
CREATE INDEX foundation_uploads_expiry ON file_uploads(expires_at,state);
CREATE INDEX foundation_operations_session ON model_provider_operations(owner_user_id,session_id,created_at DESC);
CREATE INDEX foundation_configs_connection ON model_configurations(connection_id,capability);

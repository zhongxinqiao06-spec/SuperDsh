-- Configured business resources remain separate from executable tool implementations.
CREATE TABLE business_knowledge_bases (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_user_id, id)
);

CREATE TABLE business_agent_skills (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_user_id, id)
);

CREATE TABLE business_agent_tools (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_user_id, id)
);

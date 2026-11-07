ALTER TABLE business_agent_assets ADD COLUMN source_segments_json JSONB;

CREATE TABLE business_office_plans (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  approval_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, session_id, call_id)
);

CREATE TABLE business_agent_evidence (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, id)
);

CREATE TABLE agent_skill_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  binding_version INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  run_json TEXT NOT NULL,
  claimed_call TEXT,
  claim_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id,session_id,request_id)
);
CREATE INDEX skill_runs_session ON agent_skill_runs(owner_user_id,session_id,created_at);
CREATE TABLE agent_skill_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_skill_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,version)
);

-- Generated from the owned v2_39 schema. Contains no user data.

CREATE TABLE connectors (
	id TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	name TEXT NOT NULL, 
	connection_blocked_at TEXT, 
	connection_blocked_by TEXT, 
	connection_blocked_reason TEXT, 
	connector_version TEXT, 
	connector_kind TEXT DEFAULT 'cli' NOT NULL, 
	executor_kind TEXT DEFAULT 'desktop' NOT NULL, 
	device_os TEXT, 
	status TEXT NOT NULL, 
	presence_instance_id TEXT, 
	presence_connection_id TEXT, 
	last_seen_at TEXT, 
	token_hash TEXT NOT NULL, 
	token_prefix TEXT NOT NULL, 
	revoked INTEGER DEFAULT '0' NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	user_preferences TEXT, 
	PRIMARY KEY (id)
);

CREATE TABLE dashboard_daily_metrics (
	date TEXT NOT NULL, 
	metric_key TEXT NOT NULL, 
	dimension_key TEXT DEFAULT '' NOT NULL, 
	dimension_value TEXT DEFAULT '' NOT NULL, 
	value FLOAT NOT NULL, 
	computed_at TEXT NOT NULL, 
	PRIMARY KEY (date, metric_key, dimension_key, dimension_value)
);

CREATE TABLE dashboard_settings (
	key TEXT NOT NULL, 
	value_json TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (key)
);

CREATE TABLE email_verification_codes (
	scope TEXT NOT NULL, 
	email TEXT NOT NULL, 
	purpose TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	code_hash TEXT NOT NULL, 
	nonce TEXT NOT NULL, 
	sent_at BIGINT NOT NULL, 
	expires_at BIGINT NOT NULL, 
	failed_attempts INTEGER DEFAULT '0' NOT NULL, 
	attempt_window BIGINT NOT NULL, 
	consumed_at BIGINT, 
	PRIMARY KEY (scope)
);

CREATE TABLE email_verification_limits (
	key TEXT NOT NULL, 
	window_start BIGINT NOT NULL, 
	count INTEGER NOT NULL, 
	PRIMARY KEY (key)
);

CREATE TABLE identity_audit (
	id TEXT NOT NULL, 
	actor_id TEXT NOT NULL, 
	action TEXT NOT NULL, 
	target_id TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	detail_json TEXT DEFAULT '{}' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE instance_settings (
	key TEXT NOT NULL, 
	value TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (key)
);

CREATE TABLE legacy_import_archive (
	source_table TEXT NOT NULL, 
	row_key TEXT NOT NULL, 
	payload_json TEXT NOT NULL, 
	archived_at TEXT NOT NULL, 
	PRIMARY KEY (source_table, row_key)
);

CREATE TABLE navigation_settings (
	id TEXT NOT NULL, 
	version INTEGER NOT NULL, 
	items_json TEXT NOT NULL, 
	updated_by TEXT, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE oauth_clients (
	id TEXT NOT NULL, 
	name TEXT NOT NULL, 
	redirect_uris_json TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE pairing_codes (
	id TEXT NOT NULL, 
	code TEXT NOT NULL, 
	status TEXT NOT NULL, 
	server_url TEXT, 
	connector_id TEXT, 
	connector_token TEXT, 
	expires_at TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	claimed_at TEXT, 
	consumed_at TEXT, 
	PRIMARY KEY (id), 
	UNIQUE (code)
);

CREATE TABLE roles (
	id TEXT NOT NULL, 
	name TEXT NOT NULL, 
	description TEXT DEFAULT '' NOT NULL, 
	builtin INTEGER DEFAULT '0' NOT NULL, 
	permissions_json TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE users (
	id TEXT NOT NULL, 
	password_hash TEXT NOT NULL, 
	username TEXT, 
	auth_version INTEGER DEFAULT '0' NOT NULL, 
	deleted_at TEXT, 
	deleted_by TEXT, 
	reset_required INTEGER DEFAULT '0' NOT NULL, 
	role TEXT DEFAULT 'member' NOT NULL, 
	disabled INTEGER DEFAULT '0' NOT NULL, 
	email TEXT, 
	email_verified_at TEXT, 
	display_name TEXT DEFAULT '' NOT NULL, 
	avatar TEXT, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE auth_sessions (
	id TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	refresh_hash TEXT NOT NULL, 
	previous_refresh_hash TEXT, 
	auth_version INTEGER NOT NULL, 
	client_name TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	last_seen_at TEXT NOT NULL, 
	expires_at TEXT NOT NULL, 
	revoked_at TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	UNIQUE (refresh_hash)
);

CREATE TABLE connector_protocol_capabilities (
	connector_id TEXT NOT NULL, 
	revision BIGINT NOT NULL, 
	capabilities_json TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (connector_id), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE connector_runtime_catalogs (
	connector_id TEXT NOT NULL, 
	runtime TEXT NOT NULL, 
	runtime_id TEXT NOT NULL, 
	catalog_type TEXT NOT NULL, 
	revision BIGINT NOT NULL, 
	catalog_json TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (connector_id, runtime_id, catalog_type), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE connector_runtime_types (
	connector_id TEXT NOT NULL, 
	runtime_type TEXT NOT NULL, 
	implementation_type TEXT NOT NULL, 
	display_name TEXT NOT NULL, 
	description TEXT, 
	present INTEGER DEFAULT '1' NOT NULL, 
	available INTEGER DEFAULT '1' NOT NULL, 
	reason TEXT, 
	recommended INTEGER DEFAULT '0' NOT NULL, 
	recommendation_rank INTEGER, 
	discovery_json TEXT NOT NULL, 
	config_schema_json TEXT, 
	ui_schema_json TEXT, 
	defaults_json TEXT NOT NULL, 
	capabilities_json TEXT NOT NULL, 
	metadata_json TEXT NOT NULL, 
	instance_policy TEXT NOT NULL, 
	max_instances BIGINT, 
	last_discovered_at TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (connector_id, runtime_type), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE connector_terminal_roots (
	connector_id TEXT NOT NULL, 
	terminal_id TEXT NOT NULL, 
	session_id TEXT NOT NULL, 
	root TEXT NOT NULL, 
	cwd TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (connector_id, terminal_id), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE dashboard_user_daily_facts (
	date TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	messages INTEGER DEFAULT '0' NOT NULL, 
	active_sessions INTEGER DEFAULT '0' NOT NULL, 
	created_sessions INTEGER DEFAULT '0' NOT NULL, 
	devices INTEGER DEFAULT '0' NOT NULL, 
	macos_devices INTEGER DEFAULT '0' NOT NULL, 
	windows_devices INTEGER DEFAULT '0' NOT NULL, 
	linux_devices INTEGER DEFAULT '0' NOT NULL, 
	unknown_devices INTEGER DEFAULT '0' NOT NULL, 
	codex_agents INTEGER DEFAULT '0' NOT NULL, 
	claude_agents INTEGER DEFAULT '0' NOT NULL, 
	dsh_agents INTEGER DEFAULT '0' NOT NULL, 
	last_activity_at TEXT, 
	computed_at TEXT NOT NULL, 
	PRIMARY KEY (date, user_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE fs_preview_tokens (
	token_hash TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	connector_id TEXT NOT NULL, 
	root TEXT NOT NULL, 
	path TEXT NOT NULL, 
	expires_at TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	consumed_at TEXT, 
	PRIMARY KEY (token_hash), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE mobile_login_tokens (
	token_hash TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	device_name TEXT, 
	expires_at TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	requested_at TEXT, 
	approved_at TEXT, 
	rejected_at TEXT, 
	consumed_at TEXT, 
	PRIMARY KEY (token_hash), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE oauth_accounts (
	provider TEXT NOT NULL, 
	subject TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	email TEXT, 
	display_name TEXT, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (provider, subject), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE oauth_authorization_codes (
	code_hash TEXT NOT NULL, 
	client_id TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	redirect_uri TEXT NOT NULL, 
	scope TEXT NOT NULL, 
	code_challenge TEXT NOT NULL, 
	code_challenge_method TEXT NOT NULL, 
	expires_at TEXT NOT NULL, 
	consumed_at TEXT, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (code_hash), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE platform_user_activity (
	user_id TEXT NOT NULL, 
	activity_date TEXT NOT NULL, 
	first_seen_at TEXT NOT NULL, 
	last_seen_at TEXT NOT NULL, 
	event_count INTEGER DEFAULT '0' NOT NULL, 
	PRIMARY KEY (user_id, activity_date), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE projects (
	id TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	connector_id TEXT NOT NULL, 
	name TEXT NOT NULL, 
	workspace_path TEXT NOT NULL, 
	workspace_key TEXT NOT NULL, 
	manually_created BOOLEAN DEFAULT false NOT NULL, 
	pinned INTEGER DEFAULT '0' NOT NULL, 
	pinned_at TEXT, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_projects_user_connector_workspace UNIQUE (user_id, connector_id, workspace_key), 
	CONSTRAINT uq_projects_user_name UNIQUE (user_id, name), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE recovery_codes (
	code_hash TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	consumed_at TEXT, 
	PRIMARY KEY (code_hash), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE user_roles (
	user_id TEXT NOT NULL, 
	role_id TEXT NOT NULL, 
	PRIMARY KEY (user_id, role_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(role_id) REFERENCES roles (id) ON DELETE RESTRICT
);

CREATE TABLE device_runtimes (
	connector_id TEXT NOT NULL, 
	runtime_id TEXT NOT NULL, 
	runtime_type TEXT NOT NULL, 
	name TEXT NOT NULL, 
	name_key TEXT NOT NULL, 
	config_json TEXT, 
	active INTEGER DEFAULT '0' NOT NULL, 
	status TEXT DEFAULT 'stopped' NOT NULL, 
	error_json TEXT, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (connector_id, runtime_id), 
	UNIQUE (connector_id, name_key), 
	FOREIGN KEY(connector_id, runtime_type) REFERENCES connector_runtime_types (connector_id, runtime_type) ON DELETE CASCADE, 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE
);

CREATE TABLE server_agents (
	owner_user_id TEXT NOT NULL, 
	connector_id TEXT NOT NULL, 
	runtime_id TEXT NOT NULL, 
	project_id TEXT, 
	credential_ciphertext TEXT NOT NULL, 
	status TEXT DEFAULT 'stopped' NOT NULL, 
	error TEXT, 
	lease_id TEXT, 
	lease_expires_at INTEGER DEFAULT '0' NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (owner_user_id), 
	FOREIGN KEY(owner_user_id) REFERENCES users (id) ON DELETE CASCADE, 
	UNIQUE (connector_id), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id) ON DELETE CASCADE, 
	FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE SET NULL
);

CREATE TABLE sessions (
	id TEXT NOT NULL, 
	connector_id TEXT NOT NULL, 
	project_id TEXT, 
	runtime TEXT NOT NULL, 
	runtime_id TEXT NOT NULL, 
	origin TEXT DEFAULT 'connector_import' NOT NULL, 
	model_selection_id TEXT, 
	permission_selection_id TEXT, 
	external_session_id TEXT, 
	title TEXT, 
	cwd TEXT, 
	status TEXT NOT NULL, 
	takeover INTEGER NOT NULL, 
	pinned INTEGER DEFAULT '0' NOT NULL, 
	pinned_at TEXT, 
	archived INTEGER DEFAULT '0' NOT NULL, 
	archived_at TEXT, 
	dsh_archive_legacy INTEGER DEFAULT '0' NOT NULL, 
	source_state TEXT DEFAULT 'visible' NOT NULL, 
	source_state_at TEXT, 
	source_state_reason TEXT, 
	source_observation_origin TEXT, 
	source_scan_token TEXT, 
	last_read_seq BIGINT DEFAULT '0' NOT NULL, 
	latest_turn_end_seq BIGINT DEFAULT '0' NOT NULL, 
	timeline_reset_seq BIGINT DEFAULT '0' NOT NULL, 
	last_synced_at TEXT, 
	source_observed_at TEXT, 
	last_activity_at TEXT, 
	sort_at TEXT, 
	seq BIGINT NOT NULL, 
	seq_allocated_high BIGINT DEFAULT '0' NOT NULL, 
	updated_seq BIGINT NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id), 
	CONSTRAINT fk_sessions_project_id_projects FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE RESTRICT
);

CREATE TABLE session_active_runs (
	session_id TEXT NOT NULL, 
	runtime TEXT NOT NULL, 
	runtime_id TEXT NOT NULL, 
	external_session_id TEXT, 
	status TEXT NOT NULL, 
	params_json TEXT, 
	started_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (session_id), 
	FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE TABLE session_shares (
	id TEXT NOT NULL, 
	user_id TEXT NOT NULL, 
	session_id TEXT NOT NULL, 
	scope TEXT NOT NULL, 
	snapshot_json TEXT NOT NULL, 
	allowed_file_ids_json TEXT DEFAULT '[]' NOT NULL, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE TABLE timeline_items (
	session_id TEXT NOT NULL, 
	id TEXT NOT NULL, 
	type TEXT NOT NULL, 
	status TEXT NOT NULL, 
	role TEXT, 
	order_seq INTEGER NOT NULL, 
	updated_seq BIGINT NOT NULL, 
	item_time TEXT, 
	payload_json TEXT NOT NULL, 
	PRIMARY KEY (session_id, id), 
	FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE TABLE platform_model_defaults (
	id TEXT NOT NULL, 
	provider_id TEXT NOT NULL, 
	model_id TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE platform_model_providers (
	id TEXT NOT NULL, 
	owner_user_id TEXT, 
	name TEXT NOT NULL, 
	protocol TEXT NOT NULL, 
	base_url TEXT NOT NULL, 
	key_ciphertext TEXT, 
	models_json TEXT NOT NULL, 
	enabled INTEGER DEFAULT '1' NOT NULL, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX idx_dashboard_daily_metrics_date ON dashboard_daily_metrics (date);

CREATE INDEX idx_email_codes_sent_at ON email_verification_codes (sent_at);

CREATE INDEX idx_email_limits_window ON email_verification_limits (window_start);

CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE UNIQUE INDEX idx_users_username ON users (username);

CREATE INDEX ix_auth_sessions_user_id ON auth_sessions (user_id);

CREATE INDEX idx_connector_terminal_roots_session ON connector_terminal_roots (connector_id, session_id);

CREATE INDEX idx_dashboard_user_daily_facts_user_date ON dashboard_user_daily_facts (user_id, date);

CREATE INDEX idx_oauth_accounts_user_id ON oauth_accounts (user_id);

CREATE INDEX idx_platform_user_activity_last_seen ON platform_user_activity (last_seen_at);

CREATE INDEX idx_projects_connector_workspace ON projects (connector_id, workspace_key);

CREATE INDEX idx_projects_user_pinned_updated ON projects (user_id, pinned, pinned_at, updated_at);

CREATE INDEX idx_sessions_connector_runtime_source_state ON sessions (connector_id, runtime, source_state);

CREATE INDEX idx_sessions_project_archived_sort ON sessions (project_id, archived, pinned, sort_at);

CREATE INDEX idx_session_shares_session_created ON session_shares (session_id, created_at);

CREATE INDEX idx_session_shares_user_created ON session_shares (user_id, created_at);

CREATE INDEX idx_timeline_items_item_time_type_role ON timeline_items (item_time, type, role);

CREATE INDEX idx_timeline_items_session_latest ON timeline_items (session_id, coalesce(item_time, '') DESC, order_seq DESC, updated_seq DESC);

CREATE INDEX idx_timeline_items_session_order_seq ON timeline_items (session_id, order_seq);

CREATE INDEX idx_timeline_items_session_updated_seq ON timeline_items (session_id, updated_seq);

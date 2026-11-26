"""本人注销：原子清除账号归属数据，并持久化外部存储的待清理回执。"""

from alembic import op

revision = "080dabc329f1"
down_revision = "07f392be164c"
branch_labels = None
depends_on = None

# 每组是同一种归属路径。顺序从叶子到父表，跨用户引用遇到外键冲突时整笔回滚。
PROJECTS = "SELECT id FROM studio_projects WHERE owner=p_owner"
SERIES = "SELECT id FROM studio_series WHERE owner=p_owner"
ENTITIES = "SELECT id FROM studio_entities WHERE owner_id=p_owner"
VERSIONS = f"SELECT id FROM studio_entity_versions WHERE entity_id IN ({ENTITIES})"
FAMILIES = "SELECT id FROM studio_asset_families WHERE owner_id=p_owner"
RUNS = "SELECT id FROM skill_runs WHERE owner_id=p_owner"
SESSIONS = "SELECT id FROM web_conversations WHERE owner_id=p_owner"
DEVICES = "SELECT id FROM web_devices WHERE owner_id=p_owner"

OWNED = [
    (
        f"project_id IN ({PROJECTS})",
        "studio_clips studio_tracks studio_timelines studio_shot_references studio_lines studio_shots studio_story_scenes studio_project_entity_versions studio_project_assets studio_scripts studio_commands studio_project_snapshots studio_stage_reviews studio_proposals studio_text_edits",
    ),
    ("owner_id=p_owner", "studio_library_bindings studio_library_operations"),
    (
        f"series_id IN ({SERIES})",
        "studio_series_proposals studio_series_structure_plans studio_series_commands studio_series_episodes studio_series_setting_versions",
    ),
    ("owner=p_owner", "studio_series studio_job_actions studio_generation_plans"),
    (f"entity_version_id IN ({VERSIONS})", "studio_entity_version_assets"),
    (f"family_id IN ({FAMILIES})", "studio_asset_versions"),
    ("owner_id=p_owner", "studio_asset_families"),
    ("owner=p_owner OR project IN (" + PROJECTS + ")", "studio_media_jobs"),
    (f"entity_id IN ({ENTITIES})", "studio_entity_versions studio_entity_variants"),
    ("owner_id=p_owner", "studio_entities"),
    ("owner=p_owner", "studio_assets_legacy"),
    (f"project IN ({PROJECTS})", "studio_revisions"),
    ("owner=p_owner", "studio_projects"),
    ("owner_id=p_owner", "web_tool_executions operation_receipts artifacts evidence"),
    (f"run_id IN ({RUNS})", "approvals skill_events"),
    ("owner_id=p_owner", "skill_runs resource_bindings resource_initializations"),
    ("resource_id IN (SELECT id FROM resources WHERE owner_id=p_owner)", "resource_versions"),
    ("owner_id=p_owner", "resources knowledge_documents agent_assets model_operations"),
    ("provider_id IN (SELECT id FROM model_providers WHERE owner_id=p_owner)", "model_defaults"),
    ("owner_id=p_owner", "model_providers"),
    (
        f"session_id IN ({SESSIONS})",
        "web_conversation_receipts web_conversation_events web_conversation_items",
    ),
    (
        "owner_id=p_owner",
        "web_conversation_shares web_conversation_cursors web_conversations web_projects web_socket_tickets web_shell_tasks web_terminal_bindings",
    ),
    (f"connector_id IN ({DEVICES})", "web_device_runtimes web_device_pairings"),
    (
        "owner_id=p_owner",
        "web_devices web_file_references web_file_uploads web_file_cleanup web_file_migrations web_file_entries",
    ),
    ("owner=p_owner", "runtime_receipts runtime_batches runtime_checkpoints billing_usage_quotes"),
    (
        "user_id=p_owner",
        "billing_subscription_changes billing_periods billing_operations billing_subscriptions billing_ledger_entries billing_credit_lots billing_wallets oauth_codes auth_sessions account_recovery_codes account_mobile_grants account_external_oauth_bindings",
    ),
    ("actor_id=p_owner OR target_id=p_owner", "identity_audit"),
    ("owner_id=p_owner", "account_verification_codes"),
]
# 部分旧工作区表没有用户外键。与注销共用锁，阻止已获授权的迟到写入把私有数据重新插回。
GUARDED = {
    "owner_id": "account_verification_codes web_conversation_shares web_conversation_cursors web_conversations web_projects web_socket_tickets web_shell_tasks web_terminal_bindings web_devices web_file_references web_file_uploads web_file_cleanup web_file_migrations web_file_entries resources resource_bindings resource_initializations knowledge_documents agent_assets skill_runs artifacts evidence operation_receipts web_tool_executions model_operations model_providers studio_entities studio_asset_families studio_library_bindings studio_library_operations",
    "owner": "runtime_receipts runtime_batches runtime_checkpoints runtime_execution_fences studio_projects studio_media_jobs studio_series studio_generation_plans studio_job_actions billing_usage_quotes",
    "user_id": "auth_sessions oauth_codes account_recovery_codes account_mobile_grants account_external_oauth_bindings billing_wallets billing_subscriptions billing_operations",
}


CHILDREN = [
    ("web_conversation_items", "session_id", "web_conversations"),
    ("web_conversation_events", "session_id", "web_conversations"),
    ("web_conversation_receipts", "session_id", "web_conversations"),
    ("web_device_runtimes", "connector_id", "web_devices"),
]


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN erased boolean NOT NULL DEFAULT false")
    op.execute("ALTER TABLE account_verification_codes ADD COLUMN owner_id varchar(80)")
    op.execute(
        "CREATE INDEX ix_verification_code_owner ON account_verification_codes(owner_id) WHERE owner_id IS NOT NULL"
    )
    # 老版本允许无外键的历史缓存。约束只要求新写入有父记录，延迟检查允许原有批处理顺序。
    for child, column, parent in CHILDREN:
        op.execute(
            f"ALTER TABLE {child} ADD CONSTRAINT fk_erasure_parent FOREIGN KEY ({column}) REFERENCES {parent}(id) DEFERRABLE INITIALLY DEFERRED NOT VALID"
        )
    op.execute("""CREATE TABLE account_erasure_jobs (
        owner varchar(80) PRIMARY KEY, manifest jsonb, retry_at timestamptz NOT NULL DEFAULT now()
    )""")
    op.execute(
        "CREATE INDEX ix_account_erasure_pending ON account_erasure_jobs(retry_at) WHERE manifest IS NOT NULL"
    )
    op.execute("""CREATE FUNCTION account_check_owner_write() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE uid text := to_jsonb(NEW)->>TG_ARGV[0];
    BEGIN
      IF uid IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('account-erasure:' || uid, 0));
        IF EXISTS(SELECT 1 FROM account_erasure_jobs WHERE owner=uid) THEN
          RAISE EXCEPTION 'account is closed' USING ERRCODE='23503';
        END IF;
      END IF;
      RETURN NEW;
    END $$""")
    op.execute(
        "CREATE TRIGGER guard_erased_user BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION account_check_owner_write('id')"
    )
    for column, tables in GUARDED.items():
        for table in tables.split():
            op.execute(
                f"CREATE TRIGGER guard_erased_owner BEFORE INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION account_check_owner_write('{column}')"
            )
    deletes = "\n".join(
        f"DELETE FROM {table} WHERE {predicate};"
        for predicate, tables in OWNED
        for table in tables.split()
    )
    op.execute(f"""CREATE FUNCTION account_erase_private_rows(p_owner text) RETURNS void LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE owner=p_owner AND manifest IS NOT NULL) THEN
                RAISE EXCEPTION 'missing account closure record';
            END IF;
            DELETE FROM model_defaults WHERE scope='user:' || p_owner;
            UPDATE management_dashboard_snapshots SET value=jsonb_set(value,'{{userFacts}}',
              COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(value->'userFacts') item
                WHERE item->>'userId' IS DISTINCT FROM p_owner), '[]'::jsonb))
              WHERE jsonb_typeof(value->'userFacts')='array' AND value->'userFacts' @> jsonb_build_array(jsonb_build_object('userId',p_owner));
            {deletes}
        END $$""")


def downgrade() -> None:
    op.execute("DROP FUNCTION account_erase_private_rows(text)")
    for tables in GUARDED.values():
        for table in tables.split():
            op.execute(f"DROP TRIGGER guard_erased_owner ON {table}")
    op.execute("DROP TRIGGER guard_erased_user ON users")
    op.execute("DROP FUNCTION account_check_owner_write()")
    for child, _, _ in CHILDREN:
        op.execute(f"ALTER TABLE {child} DROP CONSTRAINT fk_erasure_parent")
    op.execute("ALTER TABLE account_verification_codes DROP COLUMN owner_id")
    op.execute("DROP TABLE account_erasure_jobs")
    op.execute("ALTER TABLE users DROP COLUMN erased")

/**
 * Multi-dialect platform migration registry (plan milestone 4).
 *
 * Hosted default dialect: **mssql**. SQLite keeps the numbered better-sqlite3
 * runner as the production path today; these steps are the peer DDL bodies
 * the MSSQL PlatformStore migrator applies.
 *
 * Grow table-by-table. A missing `up.mssql` fails apply loudly.
 */

import type { MultiDialectMigrationStep } from "@mia/sql-kit"

/** MSSQL batch executor bound by the adapter (pool request or transaction). */
export type MssqlMigrationExecutor = {
  query: (sqlText: string) => Promise<unknown>
}

async function mssqlExec(executor: unknown, sqlText: string): Promise<void> {
  const ex = executor as MssqlMigrationExecutor
  await ex.query(sqlText)
}

/**
 * Pilot schema — enough identity + config to prove the migrator path.
 * Full baseline parity lands as later versions in this registry.
 */
export const platformMultiDialectMigrations: readonly MultiDialectMigrationStep[] = [
  {
    version: 1,
    name: "mssql_pilot_identity",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    upn            NVARCHAR(320)  NOT NULL CONSTRAINT PK_users PRIMARY KEY,
    username       NVARCHAR(320)  NULL,
    display_name   NVARCHAR(512)  NOT NULL,
    is_admin       INT            NOT NULL CONSTRAINT DF_users_is_admin DEFAULT (0),
    password_hash  NVARCHAR(512)  NULL,
    source         NVARCHAR(64)   NOT NULL,
    created_at     DATETIME2      NOT NULL,
    last_login_at  DATETIME2      NULL
  );
END;

IF OBJECT_ID(N'dbo.sessions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sessions (
    sid           NVARCHAR(64)   NOT NULL CONSTRAINT PK_sessions PRIMARY KEY,
    upn           NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_sessions_users REFERENCES dbo.users(upn) ON DELETE CASCADE,
    ip            NVARCHAR(128)  NULL,
    user_agent    NVARCHAR(1024) NULL,
    created_at    DATETIME2      NOT NULL,
    last_seen_at  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_sessions_upn ON dbo.sessions(upn, last_seen_at DESC);
END;

IF OBJECT_ID(N'dbo.llm_config', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.llm_config (
    id          INT            NOT NULL CONSTRAINT PK_llm_config PRIMARY KEY,
    provider    NVARCHAR(64)   NOT NULL,
    model       NVARCHAR(256)  NOT NULL,
    api_key     NVARCHAR(MAX)  NOT NULL,
    base_url    NVARCHAR(1024) NOT NULL,
    updated_at  DATETIME2      NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.connectors', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.connectors (
    id          NVARCHAR(128)  NOT NULL CONSTRAINT PK_connectors PRIMARY KEY,
    kind        NVARCHAR(64)   NOT NULL,
    body_json   NVARCHAR(MAX)  NOT NULL,
    enabled     INT            NOT NULL CONSTRAINT DF_connectors_enabled DEFAULT (1),
    created_at  DATETIME2      NOT NULL,
    updated_at  DATETIME2      NOT NULL,
    updated_by  NVARCHAR(320)  NULL
  );
END;
`,
        )
      },
    },
  },
  {
    version: 2,
    name: "mssql_pilot_threads_runs",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.threads', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.threads (
    id           NVARCHAR(64)   NOT NULL CONSTRAINT PK_threads PRIMARY KEY,
    upn          NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_threads_users REFERENCES dbo.users(upn),
    title        NVARCHAR(512)  NOT NULL CONSTRAINT DF_threads_title DEFAULT (N'New thread'),
    created_at   DATETIME2      NOT NULL,
    updated_at   DATETIME2      NOT NULL,
    archived_at  DATETIME2      NULL,
    pinned       INT            NOT NULL CONSTRAINT DF_threads_pinned DEFAULT (0)
  );
  CREATE INDEX IX_threads_upn_updated ON dbo.threads(upn, updated_at DESC);
END;

IF OBJECT_ID(N'dbo.runs', N'U') IS NULL
BEGIN
  -- No multi-path CASCADE (SQL Server forbids users→threads→runs and users→runs).
  CREATE TABLE dbo.runs (
    id             NVARCHAR(64)   NOT NULL CONSTRAINT PK_runs PRIMARY KEY,
    goal           NVARCHAR(MAX)  NOT NULL,
    status         NVARCHAR(64)   NOT NULL CONSTRAINT DF_runs_status DEFAULT (N'pending'),
    answer         NVARCHAR(MAX)  NULL,
    step_count     INT            NOT NULL CONSTRAINT DF_runs_step_count DEFAULT (0),
    error          NVARCHAR(MAX)  NULL,
    parent_run_id  NVARCHAR(64)   NULL,
    agent_id       NVARCHAR(64)   NULL,
    thread_id      NVARCHAR(64)   NULL
      CONSTRAINT FK_runs_threads REFERENCES dbo.threads(id),
    upn            NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_runs_users REFERENCES dbo.users(upn),
    display_name   NVARCHAR(512)  NOT NULL,
    created_at     DATETIME2      NOT NULL,
    completed_at   DATETIME2      NULL
  );
  CREATE INDEX IX_runs_upn ON dbo.runs(upn, created_at DESC);
  CREATE INDEX IX_runs_parent ON dbo.runs(parent_run_id);
END;

IF OBJECT_ID(N'dbo.token_usage', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.token_usage (
    run_id            NVARCHAR(64)  NOT NULL CONSTRAINT PK_token_usage PRIMARY KEY
      CONSTRAINT FK_token_usage_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    prompt_tokens     INT           NOT NULL CONSTRAINT DF_token_usage_prompt DEFAULT (0),
    completion_tokens INT           NOT NULL CONSTRAINT DF_token_usage_completion DEFAULT (0),
    total_tokens      INT           NOT NULL CONSTRAINT DF_token_usage_total DEFAULT (0),
    llm_calls         INT           NOT NULL CONSTRAINT DF_token_usage_calls DEFAULT (0),
    model             NVARCHAR(256) NOT NULL CONSTRAINT DF_token_usage_model DEFAULT (N'gpt-5.4'),
    created_at        DATETIME2     NOT NULL
  );
END;
`,
        )
      },
    },
  },
  {
    version: 3,
    name: "mssql_pilot_run_children_and_config",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.event_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.event_log (
    id          INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_event_log PRIMARY KEY,
    type        NVARCHAR(128)  NOT NULL,
    data        NVARCHAR(MAX)  NOT NULL,
    created_at  DATETIME2      NOT NULL,
    actor_upn   NVARCHAR(320)  NULL,
    run_id      NVARCHAR(64)   NULL,
    plan_id     NVARCHAR(128)  NULL
  );
  CREATE INDEX IX_event_log_time ON dbo.event_log(created_at DESC);
  CREATE INDEX IX_event_log_run_id ON dbo.event_log(run_id);
END;

IF OBJECT_ID(N'dbo.audit_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.audit_log (
    id          INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_audit_log PRIMARY KEY,
    run_id      NVARCHAR(64)   NULL,
    scope_type  NVARCHAR(32)   NOT NULL CONSTRAINT DF_audit_log_scope DEFAULT (N'run'),
    scope_id    NVARCHAR(128)  NULL,
    actor       NVARCHAR(320)  NOT NULL,
    action      NVARCHAR(128)  NOT NULL,
    detail      NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_audit_log_detail DEFAULT (N'{}'),
    timestamp   DATETIME2      NOT NULL
  );
  CREATE INDEX IX_audit_log_run ON dbo.audit_log(run_id);
END;

IF OBJECT_ID(N'dbo.checkpoints', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.checkpoints (
    run_id       NVARCHAR(64)  NOT NULL CONSTRAINT PK_checkpoints PRIMARY KEY
      CONSTRAINT FK_checkpoints_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    messages     NVARCHAR(MAX) NOT NULL,
    iteration    INT           NOT NULL CONSTRAINT DF_checkpoints_iteration DEFAULT (0),
    step_counter INT           NOT NULL CONSTRAINT DF_checkpoints_step DEFAULT (0),
    updated_at   DATETIME2     NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.sync_environments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_environments (
    name        NVARCHAR(128)  NOT NULL CONSTRAINT PK_sync_environments PRIMARY KEY,
    body_json   NVARCHAR(MAX)  NOT NULL,
    created_at  DATETIME2      NOT NULL,
    updated_at  DATETIME2      NOT NULL,
    updated_by  NVARCHAR(320)  NULL
  );
END;

IF OBJECT_ID(N'dbo.layout_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.layout_configs (
    id          NVARCHAR(128)  NOT NULL CONSTRAINT PK_layout_configs PRIMARY KEY,
    name        NVARCHAR(256)  NOT NULL,
    config      NVARCHAR(MAX)  NOT NULL,
    updated_at  DATETIME2      NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.policy_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.policy_configs (
    name        NVARCHAR(128)  NOT NULL CONSTRAINT PK_policy_configs PRIMARY KEY,
    effect      NVARCHAR(64)   NOT NULL,
    condition   NVARCHAR(MAX)  NOT NULL,
    parameters  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_policy_configs_parameters DEFAULT (N'{}'),
    source      NVARCHAR(64)   NOT NULL CONSTRAINT DF_policy_configs_source DEFAULT (N'db'),
    created_at  DATETIME2      NOT NULL,
    updated_at  DATETIME2      NULL,
    updated_by  NVARCHAR(320)  NULL
  );
END;

IF OBJECT_ID(N'dbo.sync_tool_approvals', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_tool_approvals (
    id            NVARCHAR(64)   NOT NULL CONSTRAINT PK_sync_tool_approvals PRIMARY KEY,
    actor_upn     NVARCHAR(320)  NOT NULL,
    tool_name     NVARCHAR(256)  NOT NULL,
    args_json     NVARCHAR(MAX)  NOT NULL,
    args_key      NVARCHAR(128)  NOT NULL,
    reason        NVARCHAR(MAX)  NOT NULL,
    policy_name   NVARCHAR(256)  NOT NULL,
    status        NVARCHAR(32)   NOT NULL,
    requested_at  DATETIME2      NOT NULL,
    resolved_at   DATETIME2      NULL,
    resolved_by   NVARCHAR(320)  NULL
  );
  CREATE INDEX IX_sync_tool_approvals_actor
    ON dbo.sync_tool_approvals(actor_upn, tool_name, status);
END;

IF OBJECT_ID(N'dbo.sync_evidence_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_evidence_log (
    id             NVARCHAR(64)   NOT NULL CONSTRAINT PK_sync_evidence_log PRIMARY KEY,
    tenant_id      NVARCHAR(128)  NOT NULL,
    plan_id        NVARCHAR(128)  NOT NULL,
    proposal_id    NVARCHAR(128)  NULL,
    envelope_path  NVARCHAR(1024) NOT NULL,
    pdf_path       NVARCHAR(1024) NULL,
    content_hash   NVARCHAR(128)  NOT NULL,
    signature_alg  NVARCHAR(64)   NOT NULL,
    signer_id      NVARCHAR(256)  NOT NULL,
    signature      NVARCHAR(MAX)  NOT NULL,
    created_at     DATETIME2      NOT NULL CONSTRAINT DF_sync_evidence_log_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_sync_evidence_log_plan ON dbo.sync_evidence_log(tenant_id, plan_id);
END;
`,
        )
      },
    },
  },
  {
    version: 4,
    name: "mssql_pilot_sync_catalog_and_entities",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.sync_phases', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_phases (
    tenant_id        NVARCHAR(128)  NOT NULL,
    id               NVARCHAR(128)  NOT NULL,
    label            NVARCHAR(512)  NOT NULL,
    sort_order       INT            NOT NULL CONSTRAINT DF_sync_phases_sort DEFAULT (0),
    built_in         INT            NOT NULL CONSTRAINT DF_sync_phases_builtin DEFAULT (0),
    definition_json  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_phases_def DEFAULT (N'{}'),
    CONSTRAINT PK_sync_phases PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.sync_actions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_actions (
    tenant_id        NVARCHAR(128)  NOT NULL,
    id               NVARCHAR(128)  NOT NULL,
    label            NVARCHAR(512)  NOT NULL,
    built_in         INT            NOT NULL CONSTRAINT DF_sync_actions_builtin DEFAULT (0),
    definition_json  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_actions_def DEFAULT (N'{}'),
    CONSTRAINT PK_sync_actions PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.sync_flows', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_flows (
    tenant_id     NVARCHAR(128)  NOT NULL,
    id            NVARCHAR(128)  NOT NULL,
    label         NVARCHAR(512)  NOT NULL,
    description   NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_flows_desc DEFAULT (N''),
    steps_json    NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_flows_steps DEFAULT (N'[]'),
    built_in      INT            NOT NULL CONSTRAINT DF_sync_flows_builtin DEFAULT (0),
    updated_at    DATETIME2      NOT NULL,
    updated_by    NVARCHAR(320)  NULL,
    CONSTRAINT PK_sync_flows PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.sync_value_sources', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_value_sources (
    tenant_id        NVARCHAR(128)  NOT NULL,
    id               NVARCHAR(128)  NOT NULL,
    label            NVARCHAR(512)  NOT NULL,
    built_in         INT            NOT NULL CONSTRAINT DF_sync_value_sources_builtin DEFAULT (0),
    definition_json  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_value_sources_def DEFAULT (N'{}'),
    CONSTRAINT PK_sync_value_sources PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.sync_publish_meta', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_publish_meta (
    tenant_id          NVARCHAR(128)  NOT NULL CONSTRAINT PK_sync_publish_meta PRIMARY KEY,
    published_at       DATETIME2      NOT NULL,
    published_version  NVARCHAR(128)  NOT NULL,
    catalog_version    INT            NULL
  );
END;

IF OBJECT_ID(N'dbo.sync_definitions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_definitions (
    tenant_id          NVARCHAR(128)  NOT NULL,
    entity_id          NVARCHAR(128)  NOT NULL,
    definition_json    NVARCHAR(MAX)  NOT NULL,
    published_at       DATETIME2      NULL,
    published_version  NVARCHAR(128)  NULL,
    CONSTRAINT PK_sync_definitions PRIMARY KEY (tenant_id, entity_id)
  );
END;

IF OBJECT_ID(N'dbo.sync_runs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_runs (
    plan_id              NVARCHAR(128)  NOT NULL CONSTRAINT PK_sync_runs PRIMARY KEY,
    entity_type          NVARCHAR(256)  NOT NULL,
    entity_id            NVARCHAR(256)  NOT NULL,
    entity_display_name  NVARCHAR(512)  NULL,
    source               NVARCHAR(256)  NOT NULL,
    target               NVARCHAR(256)  NOT NULL,
    actor_upn            NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_sync_runs_users REFERENCES dbo.users(upn),
    preview_inserts      INT            NOT NULL CONSTRAINT DF_sync_runs_pi DEFAULT (0),
    preview_updates      INT            NOT NULL CONSTRAINT DF_sync_runs_pu DEFAULT (0),
    preview_deletes      INT            NOT NULL CONSTRAINT DF_sync_runs_pd DEFAULT (0),
    executed_inserts     INT            NULL,
    executed_updates     INT            NULL,
    executed_deletes     INT            NULL,
    preview_totals_json  NVARCHAR(MAX)  NOT NULL,
    execute_totals_json  NVARCHAR(MAX)  NULL,
    plan_json            NVARCHAR(MAX)  NULL,
    status               NVARCHAR(64)   NOT NULL,
    error                NVARCHAR(MAX)  NULL,
    drift_detected_pct   FLOAT          NULL,
    started_at           DATETIME2      NOT NULL CONSTRAINT DF_sync_runs_started DEFAULT (SYSUTCDATETIME()),
    finished_at          DATETIME2      NULL,
    duration_ms          INT            NULL
  );
  CREATE INDEX IX_sync_runs_started ON dbo.sync_runs(started_at DESC);
END;

IF OBJECT_ID(N'dbo.sync_audit', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_audit (
    id         INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_sync_audit PRIMARY KEY,
    plan_id    NVARCHAR(128)  NOT NULL
      CONSTRAINT FK_sync_audit_runs REFERENCES dbo.sync_runs(plan_id) ON DELETE CASCADE,
    actor      NVARCHAR(320)  NOT NULL,
    actor_upn  NVARCHAR(320)  NULL,
    action     NVARCHAR(128)  NOT NULL,
    detail     NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_audit_detail DEFAULT (N'{}'),
    timestamp  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_sync_audit_plan ON dbo.sync_audit(plan_id);
END;

IF OBJECT_ID(N'dbo.entity_active', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.entity_active (
    tenant_id        NVARCHAR(128)  NOT NULL,
    id               NVARCHAR(128)  NOT NULL,
    current_version  INT            NOT NULL,
    retired_at       DATETIME2      NULL,
    CONSTRAINT PK_entity_active PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.entity_versions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.entity_versions (
    tenant_id        NVARCHAR(128)  NOT NULL,
    id               NVARCHAR(128)  NOT NULL,
    version          INT            NOT NULL,
    body_json        NVARCHAR(MAX)  NOT NULL,
    version_label    NVARCHAR(256)  NULL,
    created_by       NVARCHAR(320)  NOT NULL,
    created_at       DATETIME2      NOT NULL CONSTRAINT DF_entity_versions_created DEFAULT (SYSUTCDATETIME()),
    reason           NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_entity_versions_reason DEFAULT (N''),
    diff_json        NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_entity_versions_diff DEFAULT (N'[]'),
    CONSTRAINT PK_entity_versions PRIMARY KEY (tenant_id, id, version)
  );
END;

IF OBJECT_ID(N'dbo.attachments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.attachments (
    id               NVARCHAR(64)   NOT NULL CONSTRAINT PK_attachments PRIMARY KEY,
    scope            NVARCHAR(64)   NOT NULL,
    run_id           NVARCHAR(64)   NULL,
    owner_upn        NVARCHAR(320)  NULL,
    original_name    NVARCHAR(512)  NOT NULL,
    normalized_name  NVARCHAR(512)  NOT NULL,
    media_type       NVARCHAR(256)  NOT NULL,
    size_bytes       BIGINT         NOT NULL,
    content_hash     NVARCHAR(128)  NOT NULL,
    storage_uri      NVARCHAR(1024) NOT NULL,
    text_extract_uri NVARCHAR(1024) NULL,
    ingestion_mode   NVARCHAR(64)   NOT NULL,
    status           NVARCHAR(32)   NOT NULL CONSTRAINT DF_attachments_status DEFAULT (N'uploaded'),
    source           NVARCHAR(32)   NOT NULL CONSTRAINT DF_attachments_source DEFAULT (N'user_upload'),
    purpose_tag      NVARCHAR(256)  NULL,
    goal_snapshot    NVARCHAR(MAX)  NULL,
    uploaded_at      DATETIME2      NOT NULL,
    processed_at     DATETIME2      NULL,
    retention_until  DATETIME2      NULL
  );
  CREATE INDEX IX_attachments_run ON dbo.attachments(run_id);
  CREATE INDEX IX_attachments_owner ON dbo.attachments(owner_upn);
END;

IF OBJECT_ID(N'dbo.attachment_tags', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.attachment_tags (
    attachment_id NVARCHAR(64)  NOT NULL
      CONSTRAINT FK_attachment_tags_attachments REFERENCES dbo.attachments(id) ON DELETE CASCADE,
    tag_key       NVARCHAR(128) NOT NULL,
    tag_value     NVARCHAR(512) NOT NULL,
    CONSTRAINT PK_attachment_tags PRIMARY KEY (attachment_id, tag_key, tag_value)
  );
END;

IF OBJECT_ID(N'dbo.attachment_imports', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.attachment_imports (
    id                    NVARCHAR(64)   NOT NULL CONSTRAINT PK_attachment_imports PRIMARY KEY,
    attachment_id         NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_attachment_imports_attachments REFERENCES dbo.attachments(id) ON DELETE CASCADE,
    run_id                NVARCHAR(64)   NOT NULL,
    sandbox_path          NVARCHAR(1024) NOT NULL,
    import_mode           NVARCHAR(32)   NOT NULL,
    imported_at           DATETIME2      NOT NULL,
    imported_by_tool_call NVARCHAR(128)  NULL
  );
  CREATE INDEX IX_attachment_imports_run ON dbo.attachment_imports(run_id);
END;
`,
        )
      },
    },
  },
  {
    version: 5,
    name: "mssql_pilot_run_ops_catalog_approvals",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.run_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.run_log (
    id         INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_run_log PRIMARY KEY,
    run_id     NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_run_log_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    level      NVARCHAR(32)   NOT NULL CONSTRAINT DF_run_log_level DEFAULT (N'info'),
    message    NVARCHAR(MAX)  NOT NULL,
    timestamp  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_run_log_run ON dbo.run_log(run_id);
END;

IF OBJECT_ID(N'dbo.trace_entries', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.trace_entries (
    id          INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_trace_entries PRIMARY KEY,
    run_id      NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_trace_entries_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    seq         INT            NOT NULL CONSTRAINT DF_trace_entries_seq DEFAULT (0),
    data        NVARCHAR(MAX)  NOT NULL,
    created_at  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_trace_entries_run ON dbo.trace_entries(run_id, seq);
END;

IF OBJECT_ID(N'dbo.run_tool_approvals', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.run_tool_approvals (
    id            NVARCHAR(64)   NOT NULL CONSTRAINT PK_run_tool_approvals PRIMARY KEY,
    run_id        NVARCHAR(64)   NOT NULL,
    step_id       NVARCHAR(128)  NOT NULL,
    tool_name     NVARCHAR(256)  NOT NULL,
    args_json     NVARCHAR(MAX)  NOT NULL,
    reason        NVARCHAR(MAX)  NOT NULL,
    policy_name   NVARCHAR(256)  NOT NULL,
    status        NVARCHAR(32)   NOT NULL,
    requested_at  DATETIME2      NOT NULL,
    resolved_at   DATETIME2      NULL,
    resolved_by   NVARCHAR(320)  NULL,
    CONSTRAINT UQ_run_tool_approvals_run_step UNIQUE (run_id, step_id)
  );
  CREATE INDEX IX_run_tool_approvals_run ON dbo.run_tool_approvals(run_id, status);
END;

IF OBJECT_ID(N'dbo.tool_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.tool_results (
    id            INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_tool_results PRIMARY KEY,
    run_id        NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_tool_results_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    tool_call_id  NVARCHAR(128)  NOT NULL,
    tool_name     NVARCHAR(256)  NOT NULL,
    args_json     NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_tool_results_args DEFAULT (N'{}'),
    result_json   NVARCHAR(MAX)  NOT NULL,
    row_count     INT            NULL,
    bytes         INT            NOT NULL CONSTRAINT DF_tool_results_bytes DEFAULT (0),
    truncated     INT            NOT NULL CONSTRAINT DF_tool_results_trunc DEFAULT (0),
    goal_excerpt  NVARCHAR(MAX)  NULL,
    created_at    DATETIME2      NOT NULL
  );
  CREATE INDEX IX_tool_results_run ON dbo.tool_results(run_id);
END;

IF OBJECT_ID(N'dbo.agent_messages', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_messages (
    id            NVARCHAR(64)   NOT NULL CONSTRAINT PK_agent_messages PRIMARY KEY,
    root_run_id   NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_agent_messages_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    from_run_id   NVARCHAR(64)   NOT NULL,
    from_agent    NVARCHAR(256)  NOT NULL,
    protocol      NVARCHAR(64)   NOT NULL,
    topic         NVARCHAR(256)  NOT NULL,
    content       NVARCHAR(MAX)  NOT NULL,
    reply_to      NVARCHAR(64)   NULL,
    created_at    DATETIME2      NOT NULL
  );
  CREATE INDEX IX_agent_messages_root ON dbo.agent_messages(root_run_id, created_at);
END;

IF OBJECT_ID(N'dbo.sync_sql_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_sql_log (
    id           INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_sync_sql_log PRIMARY KEY,
    plan_id      NVARCHAR(128)  NULL,
    preview_id   NVARCHAR(128)  NULL,
    event_type   NVARCHAR(128)  NOT NULL,
    scope        NVARCHAR(128)  NULL,
    label        NVARCHAR(512)  NOT NULL,
    connection   NVARCHAR(256)  NOT NULL,
    sql_text     NVARCHAR(MAX)  NOT NULL,
    duration_ms  INT            NULL,
    row_count    INT            NULL,
    error        NVARCHAR(MAX)  NULL,
    created_at   DATETIME2      NOT NULL CONSTRAINT DF_sync_sql_log_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_sync_sql_log_plan ON dbo.sync_sql_log(plan_id, id);
END;

IF OBJECT_ID(N'dbo.sync_environment_override_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_environment_override_configs (
    name            NVARCHAR(128)  NOT NULL CONSTRAINT PK_sync_env_overrides PRIMARY KEY,
    overrides_json  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_env_overrides_json DEFAULT (N'{}'),
    updated_at      DATETIME2      NOT NULL,
    updated_by      NVARCHAR(320)  NULL
  );
END;

IF OBJECT_ID(N'dbo.sync_catalog_versions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_catalog_versions (
    tenant_id      NVARCHAR(128)  NOT NULL,
    version        INT            NOT NULL,
    snapshot_json  NVARCHAR(MAX)  NOT NULL,
    reason         NVARCHAR(MAX)  NOT NULL,
    created_by     NVARCHAR(320)  NOT NULL,
    created_at     DATETIME2      NOT NULL,
    CONSTRAINT PK_sync_catalog_versions PRIMARY KEY (tenant_id, version)
  );
END;

IF OBJECT_ID(N'dbo.sync_catalog_active', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_catalog_active (
    tenant_id   NVARCHAR(128)  NOT NULL CONSTRAINT PK_sync_catalog_active PRIMARY KEY,
    version     INT            NOT NULL,
    updated_at  DATETIME2      NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.scd2_strategy_active', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.scd2_strategy_active (
    tenant_id        NVARCHAR(128)  NOT NULL,
    id               NVARCHAR(128)  NOT NULL,
    current_version  INT            NOT NULL,
    retired_at       DATETIME2      NULL,
    CONSTRAINT PK_scd2_strategy_active PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.scd2_strategy_versions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.scd2_strategy_versions (
    tenant_id    NVARCHAR(128)  NOT NULL,
    id           NVARCHAR(128)  NOT NULL,
    version      INT            NOT NULL,
    body_json    NVARCHAR(MAX)  NOT NULL,
    created_by   NVARCHAR(320)  NOT NULL,
    created_at   DATETIME2      NOT NULL CONSTRAINT DF_scd2_strategy_versions_created DEFAULT (SYSUTCDATETIME()),
    reason       NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_scd2_strategy_versions_reason DEFAULT (N''),
    CONSTRAINT PK_scd2_strategy_versions PRIMARY KEY (tenant_id, id, version)
  );
END;

IF OBJECT_ID(N'dbo.approval_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.approval_configs (
    tenant_id       NVARCHAR(128)  NOT NULL,
    target_env      NVARCHAR(128)  NOT NULL,
    risk_tier       NVARCHAR(32)   NOT NULL,
    policy          NVARCHAR(32)   NOT NULL,
    approvers_json  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_approval_configs_approvers DEFAULT (N'[]'),
    bypass_role     NVARCHAR(128)  NULL,
    updated_at      DATETIME2      NOT NULL CONSTRAINT DF_approval_configs_updated DEFAULT (SYSUTCDATETIME()),
    updated_by      NVARCHAR(320)  NOT NULL,
    CONSTRAINT PK_approval_configs PRIMARY KEY (tenant_id, target_env, risk_tier)
  );
END;

IF OBJECT_ID(N'dbo.notification_route_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.notification_route_configs (
    id            NVARCHAR(64)   NOT NULL CONSTRAINT PK_notification_route_configs PRIMARY KEY,
    tenant_id     NVARCHAR(128)  NOT NULL,
    event_type    NVARCHAR(128)  NOT NULL,
    filter_json   NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_notification_routes_filter DEFAULT (N'{}'),
    channel       NVARCHAR(32)   NOT NULL,
    target        NVARCHAR(512)  NOT NULL,
    enabled       INT            NOT NULL CONSTRAINT DF_notification_routes_enabled DEFAULT (1),
    updated_at    DATETIME2      NOT NULL CONSTRAINT DF_notification_routes_updated DEFAULT (SYSUTCDATETIME()),
    updated_by    NVARCHAR(320)  NOT NULL
  );
  CREATE INDEX IX_notification_route_configs_ev
    ON dbo.notification_route_configs(tenant_id, event_type, enabled);
END;

IF OBJECT_ID(N'dbo.notification_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.notification_log (
    id            INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_notification_log PRIMARY KEY,
    route_id      NVARCHAR(64)   NULL,
    event_type    NVARCHAR(128)  NOT NULL,
    channel       NVARCHAR(32)   NOT NULL,
    target        NVARCHAR(512)  NOT NULL,
    payload_json  NVARCHAR(MAX)  NOT NULL,
    status        NVARCHAR(32)   NOT NULL,
    attempts      INT            NOT NULL CONSTRAINT DF_notification_log_attempts DEFAULT (0),
    last_error    NVARCHAR(MAX)  NULL,
    created_at    DATETIME2      NOT NULL CONSTRAINT DF_notification_log_created DEFAULT (SYSUTCDATETIME()),
    sent_at       DATETIME2      NULL
  );
END;

IF OBJECT_ID(N'dbo.freeze_window_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.freeze_window_configs (
    tenant_id     NVARCHAR(128)  NOT NULL,
    id            NVARCHAR(128)  NOT NULL,
    display_name  NVARCHAR(512)  NOT NULL,
    description   NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_freeze_windows_desc DEFAULT (N''),
    starts_at     DATETIME2      NOT NULL,
    ends_at       DATETIME2      NOT NULL,
    created_by    NVARCHAR(320)  NOT NULL,
    created_at    DATETIME2      NOT NULL CONSTRAINT DF_freeze_windows_created DEFAULT (SYSUTCDATETIME()),
    updated_at    DATETIME2      NOT NULL CONSTRAINT DF_freeze_windows_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_freeze_window_configs PRIMARY KEY (tenant_id, id)
  );
END;

IF OBJECT_ID(N'dbo.proposer_schedule_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.proposer_schedule_configs (
    tenant_id    NVARCHAR(128)  NOT NULL,
    source       NVARCHAR(256)  NOT NULL,
    target       NVARCHAR(256)  NOT NULL,
    cron         NVARCHAR(128)  NOT NULL,
    enabled      INT            NOT NULL CONSTRAINT DF_proposer_schedules_enabled DEFAULT (1),
    last_run_at  DATETIME2      NULL,
    next_run_at  DATETIME2      NULL,
    updated_at   DATETIME2      NOT NULL CONSTRAINT DF_proposer_schedules_updated DEFAULT (SYSUTCDATETIME()),
    updated_by   NVARCHAR(320)  NOT NULL,
    CONSTRAINT PK_proposer_schedule_configs PRIMARY KEY (tenant_id, source, target)
  );
END;

IF OBJECT_ID(N'dbo.notifications', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.notifications (
    id          NVARCHAR(64)   NOT NULL CONSTRAINT PK_notifications PRIMARY KEY,
    type        NVARCHAR(128)  NOT NULL,
    title       NVARCHAR(512)  NOT NULL,
    message     NVARCHAR(MAX)  NOT NULL,
    run_id      NVARCHAR(64)   NULL,
    step_id     NVARCHAR(128)  NULL,
    owner_upn   NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_notifications_users REFERENCES dbo.users(upn),
    actions     NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_notifications_actions DEFAULT (N'[]'),
    read        INT            NOT NULL CONSTRAINT DF_notifications_read DEFAULT (0),
    created_at  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_notifications_owner ON dbo.notifications(owner_upn, created_at DESC);
END;

IF OBJECT_ID(N'dbo.api_request_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.api_request_log (
    id                INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_api_request_log PRIMARY KEY,
    method            NVARCHAR(16)   NOT NULL,
    url               NVARCHAR(2048) NOT NULL,
    status_code       INT            NOT NULL,
    duration_ms       FLOAT          NOT NULL,
    request_body      NVARCHAR(MAX)  NULL,
    response_summary  NVARCHAR(MAX)  NULL,
    created_at        DATETIME2      NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.webhook_drain_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.webhook_drain_configs (
    id             NVARCHAR(64)   NOT NULL CONSTRAINT PK_webhook_drain_configs PRIMARY KEY,
    url            NVARCHAR(2048) NOT NULL,
    secret         NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_webhook_drain_secret DEFAULT (N''),
    event_filters  NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_webhook_drain_filters DEFAULT (N'[]'),
    enabled        INT            NOT NULL CONSTRAINT DF_webhook_drain_enabled DEFAULT (1),
    created_at     DATETIME2      NOT NULL,
    updated_at     DATETIME2      NOT NULL
  );
END;
`,
        )
      },
    },
  },
  {
    version: 6,
    name: "mssql_pilot_proposals_channels_effects",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.proposer_runs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.proposer_runs (
    id            NVARCHAR(64)   NOT NULL CONSTRAINT PK_proposer_runs PRIMARY KEY,
    tenant_id     NVARCHAR(128)  NOT NULL,
    source        NVARCHAR(256)  NOT NULL,
    target        NVARCHAR(256)  NOT NULL,
    started_at    DATETIME2      NOT NULL,
    finished_at   DATETIME2      NULL,
    status        NVARCHAR(64)   NOT NULL,
    scanned       INT            NOT NULL CONSTRAINT DF_proposer_runs_scanned DEFAULT (0),
    produced      INT            NOT NULL CONSTRAINT DF_proposer_runs_produced DEFAULT (0),
    errors        INT            NOT NULL CONSTRAINT DF_proposer_runs_errors DEFAULT (0),
    duration_ms   INT            NULL,
    triggered_by  NVARCHAR(320)  NOT NULL,
    trigger       NVARCHAR(32)   NOT NULL,
    error         NVARCHAR(MAX)  NULL
  );
  CREATE INDEX IX_proposer_runs_pair
    ON dbo.proposer_runs(tenant_id, source, target, started_at DESC);
END;

IF OBJECT_ID(N'dbo.sync_proposals', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_proposals (
    id                     NVARCHAR(64)   NOT NULL CONSTRAINT PK_sync_proposals PRIMARY KEY,
    tenant_id              NVARCHAR(128)  NOT NULL,
    run_id                 NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_sync_proposals_proposer_runs REFERENCES dbo.proposer_runs(id) ON DELETE CASCADE,
    fingerprint            NVARCHAR(256)  NOT NULL,
    source                 NVARCHAR(256)  NOT NULL,
    target                 NVARCHAR(256)  NOT NULL,
    entity_type            NVARCHAR(256)  NOT NULL,
    entity_id              NVARCHAR(256)  NOT NULL,
    entity_label           NVARCHAR(512)  NOT NULL,
    kind                   NVARCHAR(64)   NOT NULL,
    counts_json            NVARCHAR(MAX)  NOT NULL,
    detail_json            NVARCHAR(MAX)  NOT NULL,
    entity_def_version     INT            NULL,
    observed_at            DATETIME2      NOT NULL,
    enqueued_at            DATETIME2      NOT NULL CONSTRAINT DF_sync_proposals_enqueued DEFAULT (SYSUTCDATETIME()),
    status                 NVARCHAR(64)   NOT NULL,
    annotation_json        NVARCHAR(MAX)  NULL,
    annotation_failed_open INT            NOT NULL CONSTRAINT DF_sync_proposals_ann_fo DEFAULT (0),
    risk_tier              NVARCHAR(32)   NULL,
    risk_score             FLOAT          NULL,
    rank_score             FLOAT          NULL,
    plan_id                NVARCHAR(128)  NULL,
    snooze_until           DATETIME2      NULL,
    superseded_by          NVARCHAR(64)   NULL,
    last_actor             NVARCHAR(320)  NULL,
    last_action            NVARCHAR(128)  NULL,
    last_action_at         DATETIME2      NULL
  );
  CREATE INDEX IX_sync_proposals_status ON dbo.sync_proposals(tenant_id, status, risk_tier);
END;

IF OBJECT_ID(N'dbo.sync_proposal_history', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_proposal_history (
    id             INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_sync_proposal_history PRIMARY KEY,
    proposal_id    NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_sync_proposal_history_proposals REFERENCES dbo.sync_proposals(id) ON DELETE CASCADE,
    from_status    NVARCHAR(64)   NULL,
    to_status      NVARCHAR(64)   NOT NULL,
    actor          NVARCHAR(320)  NOT NULL,
    reason         NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_proposal_history_reason DEFAULT (N''),
    detail_json    NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_sync_proposal_history_detail DEFAULT (N'{}'),
    at             DATETIME2      NOT NULL CONSTRAINT DF_sync_proposal_history_at DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_sync_proposal_history_pid ON dbo.sync_proposal_history(proposal_id, at DESC);
END;

IF OBJECT_ID(N'dbo.sync_approvals', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_approvals (
    id                   NVARCHAR(64)   NOT NULL CONSTRAINT PK_sync_approvals PRIMARY KEY,
    proposal_id          NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_sync_approvals_proposals REFERENCES dbo.sync_proposals(id) ON DELETE CASCADE,
    tenant_id            NVARCHAR(128)  NOT NULL,
    requested_by         NVARCHAR(320)  NOT NULL,
    requested_at         DATETIME2      NOT NULL CONSTRAINT DF_sync_approvals_requested DEFAULT (SYSUTCDATETIME()),
    expires_at           DATETIME2      NOT NULL,
    policy               NVARCHAR(32)   NOT NULL,
    state                NVARCHAR(64)   NOT NULL,
    granted_by_1         NVARCHAR(320)  NULL,
    granted_at_1         DATETIME2      NULL,
    granted_by_2         NVARCHAR(320)  NULL,
    granted_at_2         DATETIME2      NULL,
    rejected_by          NVARCHAR(320)  NULL,
    rejected_at          DATETIME2      NULL,
    reject_reason        NVARCHAR(MAX)  NULL,
    bypass_by            NVARCHAR(320)  NULL,
    bypass_reason        NVARCHAR(MAX)  NULL,
    plan_id_at_request   NVARCHAR(128)  NULL,
    plan_hash_at_request NVARCHAR(128)  NULL
  );
  CREATE INDEX IX_sync_approvals_state ON dbo.sync_approvals(tenant_id, state, expires_at);
END;

IF OBJECT_ID(N'dbo.sync_approval_tokens', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_approval_tokens (
    token_hash    NVARCHAR(128)  NOT NULL CONSTRAINT PK_sync_approval_tokens PRIMARY KEY,
    approval_id   NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_sync_approval_tokens_approvals REFERENCES dbo.sync_approvals(id) ON DELETE CASCADE,
    action        NVARCHAR(32)   NOT NULL,
    issued_to     NVARCHAR(320)  NOT NULL,
    issued_at     DATETIME2      NOT NULL CONSTRAINT DF_sync_approval_tokens_issued DEFAULT (SYSUTCDATETIME()),
    expires_at    DATETIME2      NOT NULL,
    used_at       DATETIME2      NULL,
    used_by       NVARCHAR(320)  NULL
  );
  CREATE INDEX IX_sync_approval_tokens_app ON dbo.sync_approval_tokens(approval_id);
END;

IF OBJECT_ID(N'dbo.conversations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.conversations (
    id            NVARCHAR(64)   NOT NULL CONSTRAINT PK_conversations PRIMARY KEY,
    channel_type  NVARCHAR(32)   NOT NULL,
    sender_id     NVARCHAR(256)  NOT NULL,
    sender_name   NVARCHAR(512)  NULL,
    active_run_id NVARCHAR(64)   NULL,
    thread_id     NVARCHAR(64)   NULL,
    created_at    DATETIME2      NOT NULL,
    updated_at    DATETIME2      NOT NULL,
    CONSTRAINT UQ_conversations_channel_sender UNIQUE (channel_type, sender_id)
  );
END;

IF OBJECT_ID(N'dbo.outbound_messages', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.outbound_messages (
    id              NVARCHAR(64)   NOT NULL CONSTRAINT PK_outbound_messages PRIMARY KEY,
    conversation_id NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_outbound_messages_conversations REFERENCES dbo.conversations(id) ON DELETE CASCADE,
    channel_type    NVARCHAR(32)   NOT NULL,
    recipient_id    NVARCHAR(256)  NOT NULL,
    text            NVARCHAR(MAX)  NOT NULL,
    status          NVARCHAR(32)   NOT NULL CONSTRAINT DF_outbound_messages_status DEFAULT (N'queued'),
    attempts        INT            NOT NULL CONSTRAINT DF_outbound_messages_attempts DEFAULT (0),
    next_retry_at   DATETIME2      NULL,
    last_error      NVARCHAR(MAX)  NULL,
    created_at      DATETIME2      NOT NULL,
    delivered_at    DATETIME2      NULL
  );
  CREATE INDEX IX_outbound_messages_status ON dbo.outbound_messages(status);
END;

IF OBJECT_ID(N'dbo.delivery_attempts', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.delivery_attempts (
    id             INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_delivery_attempts PRIMARY KEY,
    message_id     NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_delivery_attempts_messages REFERENCES dbo.outbound_messages(id) ON DELETE CASCADE,
    attempt_number INT            NOT NULL,
    status         NVARCHAR(32)   NOT NULL,
    error          NVARCHAR(MAX)  NULL,
    duration_ms    INT            NOT NULL,
    created_at     DATETIME2      NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.channel_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.channel_configs (
    type          NVARCHAR(32)   NOT NULL CONSTRAINT PK_channel_configs PRIMARY KEY,
    access_token  NVARCHAR(MAX)  NOT NULL,
    verify_token  NVARCHAR(MAX)  NOT NULL,
    app_secret    NVARCHAR(MAX)  NOT NULL,
    platform_id   NVARCHAR(256)  NOT NULL,
    created_at    DATETIME2      NOT NULL,
    updated_at    DATETIME2      NOT NULL
  );
END;

IF OBJECT_ID(N'dbo.effects', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.effects (
    id          NVARCHAR(64)   NOT NULL CONSTRAINT PK_effects PRIMARY KEY,
    run_id      NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_effects_runs REFERENCES dbo.runs(id) ON DELETE CASCADE,
    seq         INT            NOT NULL CONSTRAINT DF_effects_seq DEFAULT (0),
    kind        NVARCHAR(32)   NOT NULL,
    tool        NVARCHAR(256)  NOT NULL,
    target      NVARCHAR(1024) NOT NULL,
    pre_hash    NVARCHAR(128)  NULL,
    post_hash   NVARCHAR(128)  NULL,
    status      NVARCHAR(32)   NOT NULL CONSTRAINT DF_effects_status DEFAULT (N'applied'),
    metadata    NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_effects_metadata DEFAULT (N'{}'),
    created_at  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_effects_run ON dbo.effects(run_id, seq);
END;

IF OBJECT_ID(N'dbo.file_snapshots', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.file_snapshots (
    id          NVARCHAR(64)   NOT NULL CONSTRAINT PK_file_snapshots PRIMARY KEY,
    effect_id   NVARCHAR(64)   NOT NULL
      CONSTRAINT FK_file_snapshots_effects REFERENCES dbo.effects(id) ON DELETE CASCADE,
    run_id      NVARCHAR(64)   NOT NULL,
    file_path   NVARCHAR(1024) NOT NULL,
    content     NVARCHAR(MAX)  NULL,
    hash        NVARCHAR(128)  NULL,
    file_mode   INT            NULL,
    created_at  DATETIME2      NOT NULL
  );
  CREATE INDEX IX_file_snapshots_run ON dbo.file_snapshots(run_id);
END;
`,
        )
      },
    },
  },
  {
    version: 7,
    name: "mssql_pilot_browser",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.browser_contexts', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.browser_contexts (
    id               NVARCHAR(64)   NOT NULL CONSTRAINT PK_browser_contexts PRIMARY KEY,
    owner_upn        NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_browser_contexts_users REFERENCES dbo.users(upn),
    storage_path     NVARCHAR(1024) NOT NULL,
    fingerprint_seed NVARCHAR(256)  NOT NULL,
    created_at       DATETIME2      NOT NULL CONSTRAINT DF_browser_contexts_created DEFAULT (SYSUTCDATETIME()),
    last_used_at     DATETIME2      NOT NULL CONSTRAINT DF_browser_contexts_last_used DEFAULT (SYSUTCDATETIME())
  );
  CREATE UNIQUE INDEX IX_browser_contexts_owner ON dbo.browser_contexts(owner_upn);
END;

IF OBJECT_ID(N'dbo.browser_credentials', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.browser_credentials (
    id             NVARCHAR(64)   NOT NULL CONSTRAINT PK_browser_credentials PRIMARY KEY,
    owner_upn      NVARCHAR(320)  NOT NULL
      CONSTRAINT FK_browser_credentials_users REFERENCES dbo.users(upn),
    label          NVARCHAR(256)  NOT NULL,
    kind           NVARCHAR(32)   NOT NULL,
    target_origin  NVARCHAR(1024) NOT NULL,
    enc_payload    VARBINARY(MAX) NOT NULL,
    iv             VARBINARY(64)  NOT NULL,
    auth_tag       VARBINARY(64)  NOT NULL,
    created_at     DATETIME2      NOT NULL CONSTRAINT DF_browser_credentials_created DEFAULT (SYSUTCDATETIME()),
    updated_at     DATETIME2      NOT NULL CONSTRAINT DF_browser_credentials_updated DEFAULT (SYSUTCDATETIME()),
    last_used_at   DATETIME2      NULL,
    CONSTRAINT UQ_browser_credentials_label UNIQUE (owner_upn, label)
  );
  CREATE INDEX IX_browser_credentials_owner ON dbo.browser_credentials(owner_upn);
END;

IF OBJECT_ID(N'dbo.browser_proxy_config', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.browser_proxy_config (
    owner_upn   NVARCHAR(320)  NOT NULL CONSTRAINT PK_browser_proxy_config PRIMARY KEY
      CONSTRAINT FK_browser_proxy_config_users REFERENCES dbo.users(upn),
    enc_url     VARBINARY(MAX) NOT NULL,
    iv          VARBINARY(64)  NOT NULL,
    auth_tag    VARBINARY(64)  NOT NULL,
    bypass      NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_browser_proxy_bypass DEFAULT (N''),
    updated_at  DATETIME2      NOT NULL CONSTRAINT DF_browser_proxy_updated DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.browser_domain_policy_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.browser_domain_policy_configs (
    id          NVARCHAR(64)   NOT NULL CONSTRAINT PK_browser_domain_policy_configs PRIMARY KEY,
    owner_upn   NVARCHAR(320)  NULL,
    pattern     NVARCHAR(512)  NOT NULL,
    effect      NVARCHAR(16)   NOT NULL,
    reason      NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_browser_domain_policy_reason DEFAULT (N''),
    created_at  DATETIME2      NOT NULL CONSTRAINT DF_browser_domain_policy_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_browser_domain_policy_owner ON dbo.browser_domain_policy_configs(owner_upn);
END;

IF OBJECT_ID(N'dbo.browser_audit_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.browser_audit_log (
    id          INT            NOT NULL IDENTITY(1,1) CONSTRAINT PK_browser_audit_log PRIMARY KEY,
    owner_upn   NVARCHAR(320)  NOT NULL,
    action      NVARCHAR(128)  NOT NULL,
    target_url  NVARCHAR(2048) NULL,
    detail      NVARCHAR(MAX)  NULL,
    decision    NVARCHAR(32)   NOT NULL CONSTRAINT DF_browser_audit_decision DEFAULT (N'allow'),
    created_at  DATETIME2      NOT NULL CONSTRAINT DF_browser_audit_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_browser_audit_owner ON dbo.browser_audit_log(owner_upn, created_at DESC);
END;
`,
        )
      },
    },
  },
  {
    version: 8,
    name: "mssql_pilot_eval_dataset",
    up: {
      mssql: async (executor) => {
        await mssqlExec(
          executor,
          `
IF OBJECT_ID(N'dbo.eval_dataset_entries', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.eval_dataset_entries (
    id             NVARCHAR(64)   NOT NULL CONSTRAINT PK_eval_dataset_entries PRIMARY KEY,
    thread_id      NVARCHAR(64)   NULL,
    run_id         NVARCHAR(64)   NOT NULL,
    scope_id       NVARCHAR(128)  NOT NULL,
    kind           NVARCHAR(64)   NOT NULL,
    call_index     INT            NULL,
    label          NVARCHAR(512)  NULL,
    input_json     NVARCHAR(MAX)  NOT NULL,
    output_json    NVARCHAR(MAX)  NULL,
    metadata_json  NVARCHAR(MAX)  NULL,
    created_by     NVARCHAR(320)  NOT NULL,
    created_at     DATETIME2      NOT NULL
  );
  CREATE INDEX IX_eval_dataset_run ON dbo.eval_dataset_entries(run_id);
  CREATE INDEX IX_eval_dataset_thread ON dbo.eval_dataset_entries(thread_id);
  CREATE INDEX IX_eval_dataset_created ON dbo.eval_dataset_entries(created_at DESC);
END;
`,
        )
      },
    },
  },
]

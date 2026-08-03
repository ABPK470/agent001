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
]

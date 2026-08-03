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
]

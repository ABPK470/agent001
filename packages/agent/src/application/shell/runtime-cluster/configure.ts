/**
 * host/configure.ts — boot the AgentHost.
 *
 * Phase 2 stub. The signature is the API contract; the body just builds
 * a host record with `null` adapters and empty registries. Phase 3+
 * fills in real wiring per cluster as each one migrates.
 *
 * Call this **once** at process startup from your entrypoint (server,
 * CLI, test harness). The returned `AgentHost` is immutable and is the
 * sole composition root for the agent.
 */

import type { SyncEnvironment } from "@mia/sync"
import type sql from "mssql"
import type { AgentHost } from "./host.js"

export interface ConfigureMssqlConnection extends sql.config {
  name: string
  writeEnabled?: boolean
  knowledge?: string | null
}

/**
 * Options passed by the entrypoint. Every field is optional so the
 * minimal call `configureAgent({})` yields a working-but-empty host
 * suitable for tests. Production callers fill in adapters; CLI callers
 * fill in workspace + sandbox + a shell client and leave the rest null.
 *
 * Shape is intentionally flat: one option = one adapter or one
 * primitive. No nested config objects, no factories. The host owns the
 * structure; callers just hand in finished parts.
 */
export interface ConfigureAgentOptions {
  workspaceRoot?: string

  // Filesystem + sandbox security boundaries
  filesystemBasePath?: string
  searchFilesBasePath?: string
  searchFilesExcludeDirs?: ReadonlySet<string>

  // Shell + browser-check
  shellCwd?: string
  shellSandboxStrict?: boolean
  shellClient?: AgentHost["shell"]["client"]
  browserCheckCwd?: string
  browserCheckClient?: AgentHost["browserCheck"]["client"]

  // MSSQL connection registry (shared across all per-run hosts at boot)
  mssqlConfigs?: ReadonlyArray<ConfigureMssqlConnection>
  mssqlDatabases?: AgentHost["mssql"]["databases"]
  mssqlDefaultConnection?: AgentHost["mssql"]["defaultConnection"]
  mssqlDefaultConnectionName?: string | null

  // Catalog registry (shared across all per-run hosts at boot)
  catalogInstances?: AgentHost["catalog"]["instances"]
  catalogDefaultCachePath?: AgentHost["catalog"]["defaultCachePath"]

  // Browser stack (any/all may be null in CLI / tests)
  browserContextReader?: AgentHost["browser"]["contextReader"]
  browserCredentialReader?: AgentHost["browser"]["credentialReader"]
  browserHandoffStore?: AgentHost["browser"]["handoffStore"]

  // Capability ports (null means "not configured here")
  userInput?: AgentHost["userInput"]
  attachments?: AgentHost["attachments"]
  toolKnowledge?: AgentHost["toolKnowledge"]
  tableVerdicts?: AgentHost["tableVerdicts"]

  // Tenant identity (server fills this from the active tenant config)
  tenant?: Partial<AgentHost["tenant"]>

  // Shared sync surface and hosted sync readers
  syncState?: AgentHost["sync"]
  syncEventSink?: AgentHost["sync"]["eventSink"]
  syncRunSink?: AgentHost["sync"]["runSink"]
  syncEnvironments?: ReadonlyArray<SyncEnvironment>
  syncDbProjectRoot?: string
  syncFreezeWindowsReader?: AgentHost["sync"]["freezeWindowsReader"]
}

/**
 * Build the AgentHost. Phase 2 implementation: returns a record with
 * empty maps, a no-op shell client, and `null` for every capability the
 * caller didn't provide.
 *
 * In Phase 3 the wiring for `searchFiles`, `attachments`, etc. moves
 * from each tool's module-level setter into here. This is now the only
 * supported way to configure an agent host.
 */
export function configureAgent(options: ConfigureAgentOptions = {}): AgentHost {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const mssqlDatabases = options.mssqlDatabases ?? buildMssqlDatabases(options.mssqlConfigs)
  const mssqlDefaultConnection = options.mssqlDefaultConnection ?? { value: options.mssqlDefaultConnectionName ?? null }
  const syncState = options.syncState ?? {
    eventSink: options.syncEventSink ?? NOOP_SYNC_EVENT_SINK,
    runSink: options.syncRunSink ?? NOOP_SYNC_RUN_SINK,
    freezeWindowsReader: options.syncFreezeWindowsReader ?? EMPTY_FREEZE_WINDOWS_READER,
    environments: new Map((options.syncEnvironments ?? []).map((env) => [env.name, env])),
    plans: { diskRoot: null, memCache: new Map() },
    dbProjectRoot: options.syncDbProjectRoot ?? null,
  }

  if (options.syncState) {
    if (options.syncEventSink) syncState.eventSink = options.syncEventSink
    if (options.syncRunSink) syncState.runSink = options.syncRunSink
    if (options.syncEnvironments) {
      syncState.environments.clear()
      for (const env of options.syncEnvironments) syncState.environments.set(env.name, env)
    }
    if (options.syncDbProjectRoot !== undefined) syncState.dbProjectRoot = options.syncDbProjectRoot
    if (options.syncFreezeWindowsReader) syncState.freezeWindowsReader = options.syncFreezeWindowsReader
  }

  return Object.freeze<AgentHost>({
    workspaceRoot,
    mssql: Object.freeze({
      databases: mssqlDatabases,
      defaultConnection: mssqlDefaultConnection,
    }),
    filesystem: Object.freeze({
      basePath: options.filesystemBasePath ?? workspaceRoot,
    }),
    searchFiles: Object.freeze({
      basePath: options.searchFilesBasePath ?? workspaceRoot,
      excludeDirs: options.searchFilesExcludeDirs ?? new Set<string>(),
    }),
    shell: Object.freeze({
      cwd: options.shellCwd ?? workspaceRoot,
      sandboxStrict: options.shellSandboxStrict ?? false,
      client: options.shellClient ?? NOOP_SHELL_CLIENT,
    }),
    browserCheck: Object.freeze({
      cwd: options.browserCheckCwd ?? workspaceRoot,
      client: options.browserCheckClient ?? null,
    }),
    browser: Object.freeze({
      sessions: new Map(),
      idCounter: { value: 0 },
      cleanupTimer: { value: null },
      contextReader: options.browserContextReader ?? null,
      credentialReader: options.browserCredentialReader ?? null,
      handoffStore: options.browserHandoffStore ?? null,
    }),
    userInput: options.userInput ?? null,
    attachments: options.attachments ?? null,
    toolKnowledge: options.toolKnowledge ?? null,
    tableVerdicts: options.tableVerdicts ?? null,
    catalog: Object.freeze({
      instances: options.catalogInstances ?? new Map(),
      defaultCachePath: options.catalogDefaultCachePath ?? { value: undefined },
    }),
    sync: syncState,
    tenant: Object.freeze({
      id: options.tenant?.id ?? null,
      displayName: options.tenant?.displayName ?? null,
      featureFlags: options.tenant?.featureFlags ?? new Map<string, boolean>(),
    }),
  })
}

// ── Built-in no-op adapters (Phase 2 stubs) ──────────────────────

const NOOP_SHELL_CLIENT: AgentHost["shell"]["client"] = async () => {
  throw new Error("configureAgent: no shellClient wired (pass options.shellClient).")
}

const NOOP_SYNC_EVENT_SINK: AgentHost["sync"]["eventSink"] = () => {
  // dropped on the floor — Phase 4 will swap in a real sink
}

const NOOP_SYNC_RUN_SINK: AgentHost["sync"]["runSink"] = {
  start() { /* noop */ },
  finish() { /* noop */ },
}

const EMPTY_FREEZE_WINDOWS_READER: AgentHost["sync"]["freezeWindowsReader"] = () => []

function buildMssqlDatabases(configs: ReadonlyArray<ConfigureMssqlConnection> | undefined): AgentHost["mssql"]["databases"] {
  const databases = new Map<string, AgentHost["mssql"]["databases"] extends Map<string, infer Entry> ? Entry : never>()
  for (const config of configs ?? []) {
    const { name, writeEnabled = false, knowledge = null, ...rest } = config
    databases.set(name, {
      config: {
        ...rest,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          ...rest.options,
        },
        pool: {
          min: 0,
          max: 20,
          idleTimeoutMillis: 30_000,
          ...(rest.pool ?? {}),
        },
        requestTimeout: rest.requestTimeout ?? 120_000,
        connectionTimeout: rest.connectionTimeout ?? 15_000,
      },
      pool: null,
      writeEnabled,
      knowledge,
    })
  }
  return databases
}

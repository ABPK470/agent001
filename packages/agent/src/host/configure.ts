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

import type { AgentHost } from "./host.js"

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
  mssqlDatabases?: AgentHost["mssql"]["databases"]
  mssqlDefaultConnection?: AgentHost["mssql"]["defaultConnection"]

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
}

/**
 * Build the AgentHost. Phase 2 implementation: returns a record with
 * empty maps, a no-op shell client, and `null` for every capability the
 * caller didn't provide.
 *
 * In Phase 3 the wiring for `searchFiles`, `attachments`, etc. moves
 * from each tool's module-level setter into here. In Phase 6 the
 * `AgentRuntime` class is deleted and this becomes the only way to
 * configure an agent.
 */
export function configureAgent(options: ConfigureAgentOptions = {}): AgentHost {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()

  return Object.freeze<AgentHost>({
    workspaceRoot,
    mssql: Object.freeze({
      databases: options.mssqlDatabases ?? new Map(),
      defaultConnection: options.mssqlDefaultConnection ?? { value: null },
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
    sync: Object.freeze({
      events: NOOP_SYNC_EVENT_SINK,
      runSink: NOOP_SYNC_RUN_SINK,
      recipes: { bundle: null, loadedFromPath: null },
      environments: new Map(),
      recipeReader: null,
      plans: Object.freeze({ diskRoot: null, memCache: new Map() }),
      dbProjectRoot: null,
    }),
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

const NOOP_SYNC_EVENT_SINK: AgentHost["sync"]["events"] = () => {
  // dropped on the floor — Phase 4 will swap in a real sink
}

const NOOP_SYNC_RUN_SINK: AgentHost["sync"]["runSink"] = {
  start() { /* noop */ },
  finish() { /* noop */ },
}

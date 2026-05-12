/**
 * AgentRuntime — the per-agent container for state that previously lived
 * as module-level globals in tool and sync files.
 *
 * One pattern, used everywhere
 * ----------------------------
 * Every tool that used to keep configuration in a `let` or a `const _state`
 * record now reads from `AgentRuntime.current()`. The runtime owns:
 *
 *   - tool configuration (shell / browser-check / filesystem cwd, executors,
 *     ask-user resolver, search excludes)
 *   - per-tool-call kill signals (fetch, browse-web, shell)
 *   - long-lived shared resources (mssql connection pools, browse-web
 *     sessions + cleanup timer, catalog cache, sync recipes / plans / events)
 *
 * Looking up the runtime from inside a tool
 * -----------------------------------------
 * Tools call {@link currentRuntime} (no arguments). The active runtime is
 * resolved through Node's `AsyncLocalStorage`:
 *
 *   1. If the caller is inside an `AgentRuntime#run(...)` scope, that scope's
 *      runtime is returned. The Agent loop wraps every `agent.run()` call in
 *      `this.runtime.run(...)`, so all tool invocations during a run see the
 *      Agent's own runtime.
 *   2. Otherwise (server startup, CLI bootstrap, tests that haven't
 *      installed a scope), {@link AgentRuntime.root} is returned.
 *
 * Configuring the runtime from server / CLI
 * -----------------------------------------
 * The setter functions exported by individual tool/sync files
 * (`setShellCwd`, `setMssqlConfig`, `setSyncEventSink`, …) are kept as
 * thin wrappers that mutate `currentRuntime()`. Calling them from server
 * startup mutates the root runtime (the one Agents will resolve to). No
 * code path observes the underlying object via a private name; everything
 * goes through this class.
 *
 * Disposal
 * --------
 * `AgentRuntime#dispose()` closes mssql pools, kills browser sessions, and
 * clears the browse-web cleanup timer. Server shutdown should call it.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type sql from "mssql"

// ── Type-only forward declarations ────────────────────────────────
// These imports are erased at runtime, so there is no circular dependency
// between this file and the tool/sync files that call `currentRuntime()`.
// Sourced via cluster barrels to satisfy the cluster-door lint.
import type {
  AskUserResolver,
  BrowserCheckExecutor,
  BrowserSession,
  CatalogGraph,
  ShellExecutor,
} from "./tools/index.js"
import type {
  SyncEnvironment,
  SyncEventSink,
  SyncPlan,
  SyncRecipeBundle,
  SyncRunSink,
} from "./sync/index.js"

// ── Sub-state shapes ──────────────────────────────────────────────
// Each sub-record maps 1:1 to the state that used to live in one tool /
// sync file. The grouping makes it cheap to skim the runtime and see what
// every subsystem needs.

export interface MssqlEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

export interface MssqlState {
  databases: Map<string, MssqlEntry>
  /** Override which named connection serves `connection: "default"`. */
  defaultConnection: string | null
}

export interface BrowseWebState {
  sessions: Map<string, BrowserSession>
  counter: number
  /** Per-tool-call kill signal — closes the active page when aborted. */
  killSignal: AbortSignal | null
  /** Periodic idle-session evictor; owned by `AgentRuntime#dispose()`. */
  cleanupTimer: NodeJS.Timeout | null
}

export interface ShellState {
  cwd: string
  executor: ShellExecutor | null
  sandboxStrict: boolean
  killSignal: AbortSignal | null
}

export interface BrowserCheckState {
  cwd: string
  executor: BrowserCheckExecutor | null
}

export interface FetchUrlState {
  killSignal: AbortSignal | null
}

export interface FilesystemState {
  basePath: string
}

export interface SearchFilesState {
  basePath: string
  excludeDirs: Set<string>
}

export interface AskUserState {
  resolver: AskUserResolver | null
}

export interface CatalogState {
  instances: Map<string, CatalogGraph>
  defaultCachePath: string | undefined
  defaultLineagePath: string | undefined
}

export interface SyncState {
  eventSink: SyncEventSink
  runSink: SyncRunSink
  recipes: { bundle: SyncRecipeBundle | null; loadedFromPath: string | null }
  environments: Map<string, SyncEnvironment>
  plans: { diskRoot: string | null; memCache: Map<string, SyncPlan> }
  /** Project root used to resolve relative paths in sync orchestrator helpers. */
  dbProjectRoot: string | null
}

// ── Defaults ──────────────────────────────────────────────────────

const NOOP_RUN_SINK: SyncRunSink = {
  async start() { /* noop */ },
  async finish() { /* noop */ },
}

// ── AgentRuntime ──────────────────────────────────────────────────

export class AgentRuntime {
  /**
   * Workspace root the agent operates in. Tools that need a workspace path
   * should read this rather than calling `process.cwd()` themselves.
   */
  workspaceRoot: string

  /**
   * Per-run abort signal. When set and aborted, in-flight tool calls cancel.
   * The agent loop sets this from `AgentConfig.signal`.
   */
  signal: AbortSignal | null = null

  // ── State slots ────────────────────────────────────────────────
  // Marked `readonly` because the slot identity never changes; the values
  // inside the slot are mutated in place by tool code.
  readonly mssql: MssqlState = { databases: new Map(), defaultConnection: null }
  readonly browseWeb: BrowseWebState = { sessions: new Map(), counter: 0, killSignal: null, cleanupTimer: null }
  readonly shell: ShellState = { cwd: process.cwd(), executor: null, sandboxStrict: false, killSignal: null }
  readonly browserCheck: BrowserCheckState = { cwd: process.cwd(), executor: null }
  readonly fetchUrl: FetchUrlState = { killSignal: null }
  readonly filesystem: FilesystemState = { basePath: process.cwd() }
  readonly searchFiles: SearchFilesState = { basePath: process.cwd(), excludeDirs: new Set() }
  readonly askUser: AskUserState = { resolver: null }
  readonly catalog: CatalogState = { instances: new Map(), defaultCachePath: undefined, defaultLineagePath: undefined }
  readonly sync: SyncState = {
    eventSink: () => { /* default no-op */ },
    runSink: NOOP_RUN_SINK,
    recipes: { bundle: null, loadedFromPath: null },
    environments: new Map(),
    plans: { diskRoot: null, memCache: new Map() },
    dbProjectRoot: null,
  }

  // ── ALS plumbing ───────────────────────────────────────────────
  // `als` resolves `currentRuntime()` to the runtime active in the calling
  // async context. `root` is the fallback used when no scope is active.
  static #als = new AsyncLocalStorage<AgentRuntime>()
  static #root: AgentRuntime | null = null

  constructor(options: AgentRuntimeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.signal = options.signal ?? null
  }

  /**
   * The default runtime. Used when no `AgentRuntime#run(...)` scope is
   * active — i.e. server startup, CLI bootstrap, and tests. The server
   * configures this one (mssql connections, sync sinks, executors) so
   * Agents created later automatically inherit those settings.
   */
  static root(): AgentRuntime {
    if (!AgentRuntime.#root) AgentRuntime.#root = new AgentRuntime()
    return AgentRuntime.#root
  }

  /**
   * The runtime active in the calling async context. Falls back to
   * {@link root} when no scope is active.
   *
   * Tools call this (via the `currentRuntime()` helper) instead of holding
   * module-level state.
   */
  static current(): AgentRuntime {
    return AgentRuntime.#als.getStore() ?? AgentRuntime.root()
  }

  /**
   * Run `fn` with this runtime as `AgentRuntime.current()` for its async
   * context. The `Agent` loop wraps each `agent.run()` invocation in this
   * so every tool call sees the right runtime.
   */
  run<T>(fn: () => T): T {
    return AgentRuntime.#als.run(this, fn)
  }

  /**
   * Release every resource owned by the runtime. Idempotent and safe to
   * call from a shutdown hook. After disposal, callers should not reuse
   * the runtime — make a fresh one.
   */
  async dispose(): Promise<void> {
    // mssql pools
    for (const entry of this.mssql.databases.values()) {
      if (entry.pool) {
        try { await entry.pool.close() } catch { /* ignore */ }
        entry.pool = null
      }
    }
    this.mssql.databases.clear()

    // browse-web sessions + cleanup timer
    if (this.browseWeb.cleanupTimer) {
      clearInterval(this.browseWeb.cleanupTimer)
      this.browseWeb.cleanupTimer = null
    }
    for (const [id, session] of this.browseWeb.sessions) {
      try { await session.browser.close() } catch { /* ignore */ }
      this.browseWeb.sessions.delete(id)
    }
  }
}

export interface AgentRuntimeOptions {
  workspaceRoot?: string
  signal?: AbortSignal | null
}

/** Convenience accessor — equivalent to `AgentRuntime.current()`. */
export function currentRuntime(): AgentRuntime {
  return AgentRuntime.current()
}

/**
 * Back-compat shim for the previous `getDefaultAgentRuntime()` symbol —
 * returns the root runtime. New code should use {@link AgentRuntime.root}
 * or {@link currentRuntime} directly.
 *
 * @internal
 */
export function getDefaultAgentRuntime(): AgentRuntime {
  return AgentRuntime.root()
}

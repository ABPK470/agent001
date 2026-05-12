/**
 * AgentRuntime — the per-agent container for previously-global state.
 *
 * Background
 * ----------
 * Several tools (mssql, shell, browse-web, catalog, sync, ...) historically
 * stored their configuration in module-level variables (`let _shellCwd`,
 * `let _executor`, `const _databases = new Map()`, ...). That worked when
 * one agent ran in one process; it stops working when the server runs many
 * agents concurrently or wants test isolation.
 *
 * The fix is `AgentRuntime`: a single object owned by `Agent` that holds
 * all of that state. Tools read/write the runtime instead of module
 * globals. The server constructs one runtime, configures it, and passes it
 * to each `Agent`.
 *
 * Phase 2 status
 * --------------
 * This is the SKELETON. The class exists, `Agent` accepts it (defaulting to
 * a process-wide singleton for back-compat), and the highest-leverage state
 * leaks have been removed:
 *   - `getGlobalDelegationBanditTuner` / `setGlobalDelegationBanditTuner`
 *     deleted (was dead code).
 *   - `setMssqlKillSignal` + `_fallbackKillSignal` deleted (was a known
 *     concurrency bug; ALS path now the only path).
 *
 * Per-tool conversions to runtime-owned state are tracked as Phase 2b and
 * land in follow-up commits, one tool at a time, behind the same public
 * `AgentRuntime` API. Today, `runtime.shell`, `runtime.mssql`, etc. do not
 * exist yet — tools still configure themselves through their `setX` helpers.
 * Once converted, those setters disappear and the runtime owns the state.
 *
 * Lint enforcement (Phase 3) bans new module-level `let`/`var`,
 * `getGlobal*`/`setGlobal*` exports, and top-level `setInterval`/`setTimeout`
 * outside designated runtime files, so this drift cannot recur.
 */

/**
 * Per-agent runtime container. Construct one per `Agent` (or one per server
 * for shared resources, then per-Agent overlays for run-scoped fields).
 */
export class AgentRuntime {
  /**
   * Workspace root the agent operates in. Defaults to `process.cwd()`.
   * Tools that need a workspace root should read this rather than calling
   * `process.cwd()` themselves.
   */
  workspaceRoot: string

  /**
   * Per-run AbortSignal. When set and aborted, in-flight tool calls cancel.
   * The agent loop sets this from `AgentConfig.signal`.
   */
  signal: AbortSignal | null = null

  constructor(options: AgentRuntimeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.signal = options.signal ?? null
  }

  /**
   * Release any resources owned by the runtime. After Phase 2b lands this
   * will close the mssql pool, kill browser sessions, and clear the
   * browse-web cleanup interval. Today it is a no-op placeholder so callers
   * can adopt the disposal contract now.
   */
  async dispose(): Promise<void> {
    // No-op until per-tool conversions land. Add tear-down here as each
    // tool moves its state into the runtime.
  }
}

export interface AgentRuntimeOptions {
  workspaceRoot?: string
  signal?: AbortSignal | null
}

/**
 * The default process-wide runtime. Used by `Agent` instances that don't
 * supply one of their own. Exists ONLY so existing call-sites keep working
 * while per-tool state migrations land. New code should construct its own
 * `AgentRuntime` and pass it explicitly.
 *
 * @internal
 */
let _defaultRuntime: AgentRuntime | null = null

/** @internal — used by `Agent` when no runtime is supplied. */
export function getDefaultAgentRuntime(): AgentRuntime {
  if (!_defaultRuntime) _defaultRuntime = new AgentRuntime()
  return _defaultRuntime
}

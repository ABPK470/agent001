/**
 * host/active.ts — narrow service locator for the doctrine-shaped {@link AgentHost}.
 *
 * Transition scaffolding for the Phase 4 cluster-by-cluster migration off
 * `currentRuntime()`. Tools that have been migrated to read from the host
 * use `getActiveAgentHost()` instead of the AgentRuntime god object; once
 * every cluster has migrated, the remaining work is to thread the host
 * explicitly into the tool registry (so this locator can be deleted too).
 *
 * The server boot wiring calls `setActiveAgentHost(host)` exactly once,
 * immediately after `configureAgent({...})`. Tests that exercise migrated
 * tools must call it themselves.
 *
 * See /memories/session/plan.md and docs/doctrine.md.
 */

import type { AgentHost } from "./host.js"

let _activeHost: AgentHost | null = null

/** Install the boot-time host. Idempotent: replacing is allowed (tests). */
export function setActiveAgentHost(host: AgentHost | null): void {
  _activeHost = host
}

/**
 * Return the boot-time host. Throws if the entrypoint never called
 * `setActiveAgentHost(configureAgent({...}))` — that's a wiring bug, not
 * a runtime error to swallow.
 */
export function getActiveAgentHost(): AgentHost {
  if (!_activeHost) {
    throw new Error(
      "getActiveAgentHost(): no AgentHost installed. The entrypoint must call " +
      "setActiveAgentHost(configureAgent({...})) before any host-bound tool runs.",
    )
  }
  return _activeHost
}

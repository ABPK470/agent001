/**
 * Persist a clarification resolution as a durable learned term→table mapping.
 *
 * The orchestrator calls this from `respondToRun` after a user answers a
 * `schema-match` / `canonical-ambiguity` question. The answer is parsed for a
 * `schema.table` qname; when that qname resolves in the live (boot) catalog
 * for the run's effective connection, the mapping `(subject → qname)` is
 * upserted into `resolved_terms` (org-wide, connection-scoped). Free-text
 * answers that don't contain a resolvable qname are ignored — we only learn
 * objective term→table facts, not prose.
 *
 * Best-effort: any failure (no MSSQL, no catalog, unresolvable connection) is
 * swallowed so it can never break the run's response path.
 */

import { getCatalog, resolveEffectiveMssqlConnection, type AgentHost } from "@mia/agent"
import type { ResolvedClarification } from "@mia/agent"
import { saveResolvedTerm } from "../../../infra/persistence/memory.js"
import type { BootHostDeps } from "../../../ports/orchestration.js"

/**
 * Only these clarification kinds teach a durable term→table mapping.
 * `term-undefined` is included because the user may answer it with a
 * `schema.table` pointer ("it's dim.Product"); prose answers without a
 * resolvable qname are still dropped by `extractQname`.
 */
const LEARNED_KINDS = new Set<ResolvedClarification["kind"]>([
  "schema-match",
  "canonical-ambiguity",
  "term-undefined"
])

/** Extract the first `schema.table` qname from a free-text answer. */
function extractQname(answer: string): string | null {
  const m = /\b([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(answer.trim())
  return m ? `${m[1]}.${m[2]}` : null
}

/**
 * Build a minimal host shim from boot deps sufficient for
 * `resolveEffectiveMssqlConnection` + `getCatalog` (they only touch
 * `host.mssql.databases`, `host.mssql.defaultConnection`, and
 * `host.catalog.instances`). The boot catalog Map is the SAME instance shared
 * with every per-run host, so verification here matches what the run sees.
 */
function bootHostShim(boot: BootHostDeps): AgentHost | null {
  if (!boot.mssql || !boot.catalog) return null
  return {
    mssql: boot.mssql,
    catalog: { instances: boot.catalog.instances, defaultCachePath: { value: undefined } }
  } as unknown as AgentHost
}

/**
 * If `resolved` teaches a term→table mapping the org can reuse, persist it.
 * No-op otherwise. Never throws.
 */
export function persistLearnedTermFromResolution(
  resolved: ResolvedClarification,
  goal: string,
  ownerUpn: string | null,
  boot: BootHostDeps
): void {
  if (!LEARNED_KINDS.has(resolved.kind)) return
  const qname = extractQname(resolved.answer)
  if (!qname) return

  try {
    const host = bootHostShim(boot)
    if (!host) return
    const connection = resolveEffectiveMssqlConnection(host, goal)
    const catalog = getCatalog(host, connection)
    if (!catalog || !catalog.getTable(qname)) return
    saveResolvedTerm({
      term: resolved.subject,
      qname,
      connection,
      upn: ownerUpn
    })
  } catch {
    // Best-effort: a failed learn-write must never break the run.
  }
}

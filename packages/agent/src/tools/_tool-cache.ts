/**
 * Shared org-wide cache helpers used by the heavy MSSQL tools
 * (profile_data, inspect_definition, discover_relationships).
 *
 * The cache itself lives in packages/server/src/memory/tool-knowledge.ts;
 * the server binds `host.toolKnowledge.{lookup,save,renderHeader}` when it
 * builds the per-run host. When those are null (CLI / tests with no server) the helpers
 * are no-ops and the tool falls through to live execution.
 *
 * See /memories/repo/tool-knowledge-cache.md.
 */

import type { AgentHost } from "../application/shell/runtime.js"
import type { ToolKnowledgeCachedTool, ToolKnowledgeFingerprint } from "../ports/index.js"
import { getCatalog } from "./catalog/store.js"

function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Build a catalog-derived fingerprint for the given qname. Returns null
 * when the object isn't in the catalog — caller should then skip caching
 * (no fingerprint = nothing to validate freshness against).
 */
export function fingerprintForQname(host: AgentHost, qname: string, connName: string | undefined): ToolKnowledgeFingerprint | null {
  try {
    const catalog = getCatalog(host, connName ?? "default")
    if (!catalog) return null
    const t = catalog.getTable(qname)
    if (!t) return null
    const cols = t.columns ?? []
    const sig = cols.map((c) => `${c.name}:${c.dataType}`).join("|").toLowerCase()
    return {
      cols: cols.length,
      type: t.type === "VIEW" ? "V" : "T",
      csum: fnv1a32(sig),
    }
  } catch {
    return null
  }
}

/**
 * Build a fingerprint for a logical pair / set query (e.g. discover_relationships
 * `between=[a,b]` or `column=X` or `schema=Y`). For these the fingerprint is
 * driven by the catalog `builtAt` field — a fresh catalog means schemas may
 * have changed, which warrants a re-run. Returns null when no catalog.
 */
export function fingerprintForCatalogBuild(host: AgentHost, connName: string | undefined): ToolKnowledgeFingerprint | null {
  try {
    const catalog = getCatalog(host, connName ?? "default")
    if (!catalog) return null
    // The graph type doesn't expose `builtAt`; instead use total table count
    // as a coarse fingerprint. Schema changes that add/remove tables flip it;
    // pure data changes leave it alone (correct — relationships don't depend
    // on row counts). Combined with the TTL this is safe.
    const allTables = catalog.tables
    const n = (allTables as Map<string, unknown>).size ?? 0
    return { cols: n, type: "T", csum: "graph" }
  } catch {
    return null
  }
}

/**
 * Pre-flight cache check. Returns a header-prefixed payload on hit, or null
 * on miss / stale / fingerprint mismatch / no cache bound.
 */
export function tryServeFromCache(
  host: AgentHost,
  tool: ToolKnowledgeCachedTool,
  qname: string,
  mode: string,
  connName: string | undefined,
  fingerprint: ToolKnowledgeFingerprint | null,
): string | null {
  if (!fingerprint) return null
  const tk = host.toolKnowledge
  if (!tk || !tk.lookup) return null
  const res = tk.lookup({
    tool,
    qname: qname.toLowerCase(),
    mode,
    connection: connName ?? "default",
    currentFingerprint: fingerprint,
  })
  if (!res.hit) {
    // eslint-disable-next-line no-console
    console.log(`[${tool}] source=live qname=${qname.toLowerCase()} mode=${mode} reason=${res.reason}`)
    return null
  }
  const ageHours = Math.round(res.ageMs / 3_600_000)
  // eslint-disable-next-line no-console
  console.log(`[${tool}] source=cache qname=${qname.toLowerCase()} mode=${mode} ageHours=${ageHours} fpMatch=1`)
  const header = tk.renderHeader ? tk.renderHeader(res, { tool, mode }) : ""
  return header ? `${header}\n${res.payload}` : res.payload
}

/**
 * Persist a successful live-mode result. Best-effort; failures are swallowed
 * so a cache write never breaks the tool path.
 */
export function persistToCache(
  host: AgentHost,
  tool: ToolKnowledgeCachedTool,
  qname: string,
  mode: string,
  connName: string | undefined,
  payload: string,
  fingerprint: ToolKnowledgeFingerprint | null,
): void {
  if (!fingerprint) return
  try {
    const tk = host.toolKnowledge
    if (!tk || !tk.save) return
    tk.save({
      tool,
      qname: qname.toLowerCase(),
      mode,
      connection: connName ?? "default",
      payload,
      fingerprint,
    })
  } catch {
    // non-fatal
  }
}

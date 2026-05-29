/**
 * tool_knowledge — org-wide cache of heavy MSSQL-tool outputs.
 *
 * Separate from memory_entries because these are objective ground-truth
 * facts about DB objects (not user-scoped notes). Reads are NEVER filtered
 * by upn; `created_by_upn` is provenance only. See
 * /memories/repo/tool-knowledge-cache.md and the plan in
 * /memories/session/plan.md.
 *
 * Freshness = catalog fingerprint match AND age < TTL(tool, mode).
 */

import { getDb } from "../sqlite.js"

export type CachedTool = "profile_data" | "inspect_definition" | "discover_relationships" | "explore_mssql_schema"

export interface ToolKnowledgeFingerprint {
  /** Column count from catalog snapshot at write time. */
  cols: number
  /** 'T' for TABLE, 'V' for VIEW. */
  type: "T" | "V"
  /** Stable checksum of `"col1:type1|col2:type2|..."` (32-bit FNV-1a hex). */
  csum: string
}

export interface ToolKnowledgeHit {
  hit: true
  payload: string
  ageMs: number
  profiledAt: number
  fingerprint: ToolKnowledgeFingerprint
  createdByUpn: string | null
}

export interface ToolKnowledgeMiss {
  hit: false
  reason: "miss" | "stale" | "fingerprint"
}

export type ToolKnowledgeResult = ToolKnowledgeHit | ToolKnowledgeMiss

// ── TTLs ──────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000

/** Per-tool / per-mode TTL in ms. Falls back to `default` when mode unknown. */
export const TOOL_KNOWLEDGE_TTL: Record<CachedTool, Record<string, number>> = {
  profile_data: { fast: 30 * DAY_MS, deep: 14 * DAY_MS, default: 30 * DAY_MS },
  inspect_definition: { default: 30 * DAY_MS },
  discover_relationships: { default: 60 * DAY_MS },
  // explore_mssql_schema(table=…) returns INFORMATION_SCHEMA column metadata.
  // Same shape as a profile_data fast "Columns" section, so reuse the 30d TTL.
  // Catalog-fingerprint mismatch will refresh sooner whenever columns change.
  explore_mssql_schema: { columns: 30 * DAY_MS, default: 30 * DAY_MS },
}

export function ttlForToolMode(tool: CachedTool, mode: string): number {
  const map = TOOL_KNOWLEDGE_TTL[tool]
  return map[mode] ?? map["default"] ?? 30 * DAY_MS
}

// ── Fingerprint ───────────────────────────────────────────────────

/**
 * Stable 32-bit FNV-1a hash → lowercase 8-char hex.
 * Used purely as a fingerprint component; not security-sensitive.
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Build a fingerprint from a catalog table snapshot. Returns null when the
 * object isn't in the catalog — caller should then skip caching.
 */
export function fingerprintFromCatalogTable(
  table: { type: "TABLE" | "VIEW"; columns: ReadonlyArray<{ name: string; dataType: string }> } | null | undefined,
): ToolKnowledgeFingerprint | null {
  if (!table) return null
  const cols = table.columns ?? []
  const sig = cols
    .map((c) => `${c.name}:${c.dataType}`)
    .join("|")
    .toLowerCase()
  return {
    cols: cols.length,
    type: table.type === "VIEW" ? "V" : "T",
    csum: fnv1a32(sig),
  }
}

export function fingerprintsEqual(
  a: ToolKnowledgeFingerprint | null | undefined,
  b: ToolKnowledgeFingerprint | null | undefined,
): boolean {
  if (!a || !b) return false
  return a.cols === b.cols && a.type === b.type && a.csum === b.csum
}

// ── Lookup ────────────────────────────────────────────────────────

export interface LookupOptions {
  tool: CachedTool
  qname: string
  mode?: string
  connection?: string
  /** Current fingerprint computed from the live catalog snapshot. */
  currentFingerprint: ToolKnowledgeFingerprint | null
  /** Override TTL (ms). Defaults to `ttlForToolMode(tool, mode)`. */
  ttlMs?: number
  /** Caller's clock (ms). Defaults to `Date.now()`. Useful for tests. */
  now?: number
}

interface Row {
  payload_text: string
  fingerprint: string
  created_at: number
  created_by_upn: string | null
}

export function lookupToolKnowledge(opts: LookupOptions): ToolKnowledgeResult {
  const mode = opts.mode ?? ""
  const connection = opts.connection ?? "default"
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? ttlForToolMode(opts.tool, mode)

  const row = getDb()
    .prepare<unknown[], Row>(
      `SELECT payload_text, fingerprint, created_at, created_by_upn
         FROM tool_knowledge
        WHERE tool = ? AND qname = ? AND mode = ? AND connection = ?
        LIMIT 1`,
    )
    .get(opts.tool, opts.qname, mode, connection)

  if (!row) return { hit: false, reason: "miss" }

  const ageMs = Math.max(0, now - row.created_at)
  if (ageMs > ttlMs) return { hit: false, reason: "stale" }

  let cachedFp: ToolKnowledgeFingerprint | null = null
  try {
    cachedFp = JSON.parse(row.fingerprint) as ToolKnowledgeFingerprint
  } catch {
    cachedFp = null
  }
  if (!fingerprintsEqual(cachedFp, opts.currentFingerprint)) {
    return { hit: false, reason: "fingerprint" }
  }

  // Bump hit telemetry. Fire-and-forget; failure is non-fatal.
  try {
    getDb()
      .prepare(
        `UPDATE tool_knowledge
            SET last_hit_at = ?, hit_count = hit_count + 1
          WHERE tool = ? AND qname = ? AND mode = ? AND connection = ?`,
      )
      .run(now, opts.tool, opts.qname, mode, connection)
  } catch { /* non-fatal */ }

  return {
    hit: true,
    payload: row.payload_text,
    ageMs,
    profiledAt: row.created_at,
    fingerprint: cachedFp!,
    createdByUpn: row.created_by_upn,
  }
}

// ── Save ──────────────────────────────────────────────────────────

export interface SaveOptions {
  tool: CachedTool
  qname: string
  mode?: string
  connection?: string
  payload: string
  fingerprint: ToolKnowledgeFingerprint
  upn?: string | null
  now?: number
}

export function saveToolKnowledge(opts: SaveOptions): void {
  const mode = opts.mode ?? ""
  const connection = opts.connection ?? "default"
  const now = opts.now ?? Date.now()
  const fpJson = JSON.stringify(opts.fingerprint)
  const bytes = Buffer.byteLength(opts.payload, "utf8")

  getDb()
    .prepare(
      `INSERT INTO tool_knowledge
         (tool, qname, mode, connection, payload_text, fingerprint, bytes, created_by_upn, created_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(tool, qname, mode, connection) DO UPDATE SET
         payload_text   = excluded.payload_text,
         fingerprint    = excluded.fingerprint,
         bytes          = excluded.bytes,
         created_by_upn = excluded.created_by_upn,
         created_at     = excluded.created_at,
         hit_count      = 0,
         last_hit_at    = NULL`,
    )
    .run(opts.tool, opts.qname, mode, connection, opts.payload, fpJson, bytes, opts.upn ?? null, now)
}

// ── Prune ─────────────────────────────────────────────────────────

export interface PruneOptions {
  /** Drop rows older than this age (ms). */
  maxAgeMs: number
  now?: number
}

export function pruneToolKnowledge(opts: PruneOptions): number {
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.maxAgeMs
  const info = getDb()
    .prepare(`DELETE FROM tool_knowledge WHERE created_at < ?`)
    .run(cutoff)
  return typeof info.changes === "number" ? info.changes : 0
}

// ── Header ────────────────────────────────────────────────────────

/**
 * Prepend a [cached from ...] header so the agent can see this result came
 * from the cache and reason about freshness. Format kept stable for tests.
 */
export function renderCachedHeader(hit: ToolKnowledgeHit, opts: { tool: CachedTool; mode?: string }): string {
  const profiledIso = new Date(hit.profiledAt).toISOString().slice(0, 10)
  const ageHours = Math.round(hit.ageMs / (60 * 60 * 1000))
  const modePart = opts.mode ? `, mode=${opts.mode}` : ""
  return `[cached from ${profiledIso}${modePart}, ageHours=${ageHours}, source=tool_knowledge]`
}

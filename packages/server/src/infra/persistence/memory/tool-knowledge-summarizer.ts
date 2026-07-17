/**
 * tool-knowledge summarizer — compact, deterministic per-tool digests
 * of `tool_knowledge.payload_text` for inline rendering inside the
 * `<known_objects>` system anchor.
 *
 * Why: the org-wide tool cache (`tool_knowledge`) already prevents a
 * DB round-trip when the model re-calls `profile_data` /
 * `inspect_definition` / `discover_relationships` / `explore_mssql_schema`
 * with the same params. But the *model itself* still emits the tool
 * call — it has no way to know the cache exists. Inlining a compact
 * digest of the cached payload into the system prompt lets the model
 * see the answer and skip the call entirely (persona HARD RULE then
 * permits trusting it as authoritative).
 *
 * Design constraints:
 *   - Pure & deterministic. Regex / string-prefix parsing only. No LLM.
 *   - Never throws on malformed input — falls back to a raw-prefix
 *     digest so a payload-format change degrades gracefully instead
 *     of erroring out the whole prompt build.
 *   - Per-summary char budget enforced; the caller still gates the
 *     total block budget separately.
 *   - Output is plain text, indented two spaces under a header the
 *     caller renders. We do NOT include the qname / freshness header
 *     here — the caller has that context and renders it once.
 *
 * Payload formats this summarizer expects (per current tool emitters
 * — verified against the live code, not invented):
 *   - explore_mssql_schema(columns):
 *       "Columns for <qname>:\n" + formatResults pipe-table
 *   - profile_data(fast):
 *       "Profile (FAST mode) for <qname>:\n  Type: ...\n  Total rows: N ...\n
 *        \nIndexes (N):\n  ...\n\nColumns (N):\n  <name> (<type>, <null>)\n
 *        \nSample rows (N):\n  ..."
 *   - profile_data(deep):
 *       similar header + per-column distinct/null/sketch sections
 *   - inspect_definition(definition):
 *       DDL text + section headers ("Columns:", "Foreign keys:", etc.)
 *   - discover_relationships(fk|paths|schema|column):
 *       lists of "a.b.col → c.d.col" lines, sometimes with prose
 */

import type { CachedTool } from "./tool-knowledge.js"

/** Hard upper bound on any single summary, regardless of tool. */
const PER_SUMMARY_CHAR_CAP = 600

/**
 * Maximum number of "interesting" lines (e.g. columns) any single
 * summarizer will keep before truncating with "…". Keeps the digest
 * tight for wide tables without losing the head.
 */
const MAX_LINES_PER_SECTION = 12

export interface SummarizeOptions {
  /** Override the per-summary character cap (rare; tests). */
  maxChars?: number
}

/**
 * Compact a cached `tool_knowledge.payload_text` into a 1-3 line
 * indented summary suitable for inline injection. Never throws.
 */
export function summarizeCachedPayload(
  tool: CachedTool,
  mode: string,
  payload: string,
  opts: SummarizeOptions = {}
): string {
  const cap = Math.max(80, Math.min(opts.maxChars ?? PER_SUMMARY_CHAR_CAP, 2000))
  try {
    let summary: string
    switch (tool) {
      case "explore_mssql_schema":
        summary = summarizeExploreSchema(payload)
        break
      case "profile_data":
        summary = mode === "deep" ? summarizeProfileDeep(payload) : summarizeProfileFast(payload)
        break
      case "inspect_definition":
        summary = summarizeInspectDefinition(payload)
        break
      case "discover_relationships":
        summary = summarizeDiscoverRelationships(payload)
        break
      default:
        summary = rawFallback(payload)
    }
    return clampToCap(summary, cap)
  } catch {
    // Belt-and-braces — the per-tool helpers are already non-throwing,
    // but if any regex / split blows up on some pathological payload,
    // fall back to a raw prefix so the prompt build still succeeds.
    return clampToCap(rawFallback(payload), cap)
  }
}

// ── Per-tool compactors ──────────────────────────────────────────

/**
 * explore_mssql_schema(columns) → "cols: A(int [PK]), B(varchar), …"
 *
 * Payload starts with "Columns for <qname>:" then a formatResults
 * pipe table. We pull column names + data types out of the table
 * (first 2 columns: COLUMN_NAME, DATA_TYPE) and append a "[PK]" /
 * "[FK→x]" marker if the table carries those columns.
 *
 * When the payload also carries a "Value ranges (surrogate keys, …):"
 * section (emitted live by explore_mssql_schema for surrogate-shaped
 * columns) we inline those ranges into the matching column entries
 * as `pkMonth(int 1..612 [PK])`. This is the single most important
 * signal for stopping the "treat surrogate key like YYYYMM" bug
 * class — surface it where the LLM is reading.
 */
function summarizeExploreSchema(payload: string): string {
  const lines = payload.split(/\r?\n/)
  // Skip "Columns for X:" header + any blank then locate the pipe header.
  let hdrIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes("|") && /COLUMN_NAME/i.test(lines[i]!)) {
      hdrIdx = i
      break
    }
  }
  if (hdrIdx < 0) return rawFallback(payload)

  const hdrCells = splitPipeRow(lines[hdrIdx]!)
  const idxName = hdrCells.findIndex((c) => /^COLUMN_NAME$/i.test(c))
  const idxType = hdrCells.findIndex((c) => /^DATA_TYPE$/i.test(c))
  const idxPk = hdrCells.findIndex((c) => /^IS_PK$/i.test(c))
  const idxFk = hdrCells.findIndex((c) => /^FK_REFERENCE$/i.test(c))
  if (idxName < 0 || idxType < 0) return rawFallback(payload)

  const ranges = extractSurrogateRanges(payload)

  const cols: string[] = []
  // Skip separator row (dashes) — it has no useful content.
  for (let i = hdrIdx + 1; i < lines.length && cols.length < MAX_LINES_PER_SECTION; i++) {
    const row = lines[i]!
    if (!row.includes("|")) continue
    if (/^[\s|+-]+$/.test(row)) continue
    const cells = splitPipeRow(row)
    const name = cells[idxName]
    const dt = cells[idxType]
    if (!name || !dt) continue
    const pk = idxPk >= 0 && /^(1|true|yes)$/i.test(cells[idxPk] ?? "") ? " [PK]" : ""
    const fk = idxFk >= 0 && cells[idxFk] && cells[idxFk] !== "NULL" ? ` [FK→${cells[idxFk]}]` : ""
    const range = ranges.get(name.toLowerCase())
    const rangeStr = range ? ` ${range.min}..${range.max}` : ""
    cols.push(`${name}(${dt}${rangeStr}${pk}${fk})`)
  }
  if (cols.length === 0) return rawFallback(payload)
  const more = countDataRows(lines, hdrIdx) > cols.length ? ", …" : ""
  return `cols: ${cols.join(", ")}${more}`
}

/**
 * profile_data(fast) → "fast: rows=N, type=T, indexes=N, cols(N): A(int), pkMonth(int 1..612), B(varchar), …"
 *
 * Surrogate-shaped columns (pk*, fk*, *Id, *Key, …) carry an inline
 * "min..max" hint when sys.stats coverage is available — the model
 * needs that range to avoid filtering surrogate ints by business
 * codes like YYYYMM. Non-surrogate numeric columns deliberately do
 * NOT carry a range (it would imply a constraint that isn't real).
 */
function summarizeProfileFast(payload: string): string {
  const rows = extractTotalRows(payload)
  const type = extractType(payload)
  const idxCount = extractCount(payload, /^Indexes \((\d+)\):/m)
  const colCount = extractCount(payload, /^Columns \((\d+)\):/m)
  const cols = extractProfileColumns(payload)

  const parts: string[] = ["fast"]
  if (rows !== null) parts.push(`rows=${rows}`)
  if (type) parts.push(`type=${type}`)
  if (idxCount !== null) parts.push(`indexes=${idxCount}`)

  let head = parts.join(", ")
  if (cols.length > 0) {
    const more = colCount !== null && colCount > cols.length ? `, …(${colCount - cols.length} more)` : ""
    head += `; cols(${colCount ?? cols.length}): ${cols.join(", ")}${more}`
  }
  return head || rawFallback(payload)
}

/**
 * profile_data(deep) → same head as fast plus per-col distinct/null highlights.
 */
function summarizeProfileDeep(payload: string): string {
  const head = summarizeProfileFast(payload).replace(/^fast/, "deep")
  // Deep mode adds per-column distinct/null lines like
  //   "  Distinct: 845,123 (95.2%)" / "  Nulls: 12 (0.0%)"
  // Pluck up to 3 notable ones (≥30% distinct or ≥10% null).
  const notes: string[] = []
  const blocks = payload.split(/\n  (\S+) \(/).slice(1) // ["colName", "rest", ...]
  for (let i = 0; i + 1 < blocks.length && notes.length < 3; i += 2) {
    const colName = blocks[i]!
    const body = blocks[i + 1]!
    const distinct = body.match(/Distinct:\s*[\d,]+\s*\((\d+(?:\.\d+)?)%\)/)
    const nulls = body.match(/Nulls?:\s*[\d,]+\s*\((\d+(?:\.\d+)?)%\)/)
    const dPct = distinct ? parseFloat(distinct[1]!) : NaN
    const nPct = nulls ? parseFloat(nulls[1]!) : NaN
    if (dPct >= 30) notes.push(`${colName} distinct=${dPct}%`)
    else if (nPct >= 10) notes.push(`${colName} nulls=${nPct}%`)
  }
  return notes.length > 0 ? `${head}; ${notes.join(", ")}` : head
}

/**
 * inspect_definition → "<type> N cols, PK=…, FKs=N, indexes=N"
 *
 * Payload is freeform DDL + section headers; we look for common
 * markers but degrade to first-line on miss.
 */
function summarizeInspectDefinition(payload: string): string {
  const firstLine = (payload.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim()
  const typeM = firstLine.match(/\b(TABLE|VIEW|PROCEDURE|FUNCTION)\b/i)
  const colCount = extractCount(payload, /^Columns \((\d+)\)/m)
  const fkCount = extractCount(payload, /^Foreign keys?\s*\((\d+)\)/im)
  const ixCount = extractCount(payload, /^Indexes \((\d+)\)/m)
  const pkM = payload.match(/Primary key:\s*([^\n]+)/i)

  const parts: string[] = []
  if (typeM) parts.push(typeM[1]!.toUpperCase())
  if (colCount !== null) parts.push(`${colCount} cols`)
  if (pkM) parts.push(`PK=${pkM[1]!.trim().slice(0, 40)}`)
  if (fkCount !== null) parts.push(`FKs=${fkCount}`)
  if (ixCount !== null) parts.push(`indexes=${ixCount}`)
  if (parts.length === 0) return rawFallback(payload)
  return `definition: ${parts.join(", ")}`
}

/**
 * discover_relationships → "rels: a.b.c→d.e.f; g.h.i→j.k.l; …"
 *
 * Pulls "x → y" arrow lines (the common shape across fk / paths /
 * schema / column modes). Caps at MAX_LINES_PER_SECTION arrows.
 */
function summarizeDiscoverRelationships(payload: string): string {
  const lines = payload.split(/\r?\n/)
  const arrows: string[] = []
  const ARROW_RE = /([A-Za-z_][\w.]*)\s*(?:→|->)\s*([A-Za-z_][\w.]*)/
  for (const line of lines) {
    if (arrows.length >= MAX_LINES_PER_SECTION) break
    const m = line.match(ARROW_RE)
    if (!m) continue
    arrows.push(`${m[1]}→${m[2]}`)
  }
  if (arrows.length === 0) return rawFallback(payload)
  return `rels(${arrows.length}): ${arrows.join("; ")}`
}

// ── Helpers ───────────────────────────────────────────────────────

function splitPipeRow(row: string): string[] {
  return row.split("|").map((c) => c.trim())
}

function countDataRows(lines: string[], hdrIdx: number): number {
  let n = 0
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const row = lines[i]!
    if (!row.includes("|")) continue
    if (/^[\s|+-]+$/.test(row)) continue
    n++
  }
  return n
}

function extractTotalRows(payload: string): string | null {
  const m = payload.match(/Total rows:\s*([\d,]+)/i)
  if (!m) return null
  // Keep the human-readable comma form — it's already compact enough.
  return m[1]!
}

function extractType(payload: string): string | null {
  const m = payload.match(/^\s*Type:\s*(\w+)/m)
  return m ? m[1]!.toLowerCase() : null
}

function extractCount(payload: string, re: RegExp): number | null {
  const m = payload.match(re)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Pluck up to MAX_LINES_PER_SECTION column entries from a profile
 * payload's "Columns (N):" section. Format per emitter:
 *   "  ColName (data_type, nullable)"
 */
/**
 * Pluck up to MAX_LINES_PER_SECTION column entries from a profile
 * payload's "Columns (N):" section. Format per emitter:
 *   "  ColName (data_type, nullable)"
 *   "    Min: X | Max: Y  (stats updated …)"   ← optional, surrogate-only
 *
 * The Min/Max line is emitted by profile_data for every column that has
 * sys.stats coverage. We inline it into the compact column entry as
 * `pkMonth(int 1..612)` ONLY for surrogate-shaped names — including
 * a numeric range for an "Amount" or "Date" column would mislead the
 * model into treating the range as a business constraint. The point
 * of the range hint is the surrogate-vs-business-code disambiguation;
 * keep it scoped to where that ambiguity exists.
 */
function extractProfileColumns(payload: string): string[] {
  const out: string[] = []
  // Match a column header line, optionally followed (on the next line)
  // by its Min/Max line. The Min/Max group is optional so columns
  // without stats still parse.
  const re =
    /^ {2}(\S+) \((\w+),\s*(?:nullable|NOT NULL)\)(?:\r?\n {4}Min:\s*([^|\r\n]+?)\s*\|\s*Max:\s*([^\r\n(]+?)(?=\s*(?:\(|\r|\n|$)))?/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(payload)) !== null) {
    if (out.length >= MAX_LINES_PER_SECTION) break
    const name = m[1]!
    const dt = m[2]!
    const minVal = m[3]?.trim()
    const maxVal = m[4]?.trim()
    if (minVal && maxVal && minVal !== "NULL" && maxVal !== "NULL" && isSurrogateLikeName(name)) {
      out.push(`${name}(${dt} ${minVal}..${maxVal})`)
    } else {
      out.push(`${name}(${dt})`)
    }
  }
  return out
}

/**
 * Parse the optional "Value ranges (surrogate keys, …):" section
 * that explore_mssql_schema appends to its payload. Each entry is
 * `  ColName: <min>..<max>`. Returns a name→{min,max} map (lowercased
 * keys for case-insensitive lookup by the column summarizer).
 *
 * This is the data path that lets `<known_objects>` carry per-column
 * value ranges all the way from the live SQL to the model prompt.
 */
function extractSurrogateRanges(payload: string): Map<string, { min: string; max: string }> {
  const out = new Map<string, { min: string; max: string }>()
  const idx = payload.indexOf("Value ranges (surrogate keys")
  if (idx < 0) return out
  const tail = payload.slice(idx)
  const re = /^ {2}([A-Za-z_][\w]*):\s*([^.\r\n][^.\r\n]*?)\.\.([^\r\n]+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(tail)) !== null) {
    out.set(m[1]!.toLowerCase(), { min: m[2]!.trim(), max: m[3]!.trim() })
  }
  return out
}

/**
 * Surrogate-shape predicate — mirrors the same heuristic used by the
 * live explore_mssql_schema emitter so the cached payload and the
 * summarizer agree on which columns are surrogate-like. Keeping the
 * rule narrow (name-only, no type check needed because the payload
 * line already encodes the column's type) prevents accidentally
 * tagging business-meaningful numeric columns.
 */
function isSurrogateLikeName(name: string): boolean {
  const n = name.trim()
  if (/^(pk|fk|sk)[A-Z_]/.test(n)) return true
  if (/^(pk|fk|sk)$/i.test(n)) return true
  if (/(Id|Key|Sk)$/.test(n) && n.length > 2) return true
  if (/_(id|key|sk)$/i.test(n)) return true
  return false
}

function rawFallback(payload: string): string {
  // Strip leading whitespace lines, collapse internal runs of
  // whitespace, take the first ~200 chars. Mark as raw so the model
  // (and any later inspector) can tell parsing didn't fire.
  const collapsed = payload.replace(/\s+/g, " ").trim()
  return `[raw] ${collapsed.slice(0, 200)}`
}

function clampToCap(s: string, cap: number): string {
  if (s.length <= cap) return s
  return s.slice(0, cap - 1) + "…"
}

/**
 * MSSQL connector knowledge packs — split curated prose so a metadata ask
 * does not pay for mart/BI playbooks (and the reverse).
 *
 * Packs are marked in the knowledge markdown:
 *   <!-- mia-pack:shared --> … <!-- /mia-pack:shared -->
 *   <!-- mia-pack:meta -->   … <!-- /mia-pack:meta -->
 *   <!-- mia-pack:mart -->   … <!-- /mia-pack:mart -->
 *
 * Unmarked files (custom tenants) stay one body: every selection except
 * `header`/`none` returns the full text. Silent slicing would be unsafe.
 */

export type KnowledgePackId = "shared" | "meta" | "mart"

/**
 * What to inject for this run.
 * - `none`   — no knowledge body (non-data frames)
 * - `header` — shared + compact pack index (~orientation, low score)
 * - `meta`   — shared + platform metadata (core/gate/agent/etl/…)
 * - `mart`   — shared + business mart (publish/dim/fact/…)
 * - `both`   — shared + meta + mart
 */
export type KnowledgePackSelection = "none" | "header" | "meta" | "mart" | "both"

export interface ParsedKnowledgePacks {
  /** True when at least one pack marker was found. */
  marked: boolean
  shared: string
  meta: string
  mart: string
  /** Original body (trimmed). */
  raw: string
}

const PACK_RE =
  /<!--\s*mia-pack:(shared|meta|mart)\s*-->([\s\S]*?)<!--\s*\/mia-pack:\1\s*-->/gi

const HEADER_CHAR_CAP = 900

export function parseKnowledgePacks(body: string): ParsedKnowledgePacks {
  const raw = body.trim()
  const out: ParsedKnowledgePacks = {
    marked: false,
    shared: "",
    meta: "",
    mart: "",
    raw
  }
  if (!raw) return out

  let matched = false
  for (const m of raw.matchAll(PACK_RE)) {
    matched = true
    const id = m[1] as KnowledgePackId
    const text = (m[2] ?? "").trim()
    if (id === "shared") out.shared = text
    else if (id === "meta") out.meta = text
    else if (id === "mart") out.mart = text
  }
  out.marked = matched
  return out
}

/**
 * Compact orientation when the goal is only marginally data-shaped.
 * Prefer shared pack + schema-name index from meta/mart headings — not the
 * first markdown H2 alone (which is useless for the current MyMI file).
 */
export function extractKnowledgeHeader(body: string): string {
  const packs = parseKnowledgePacks(body)
  if (packs.marked) {
    const index = packSchemaIndex(packs)
    const parts = [packs.shared, index].filter((p) => p.length > 0)
    const joined = parts.join("\n\n").trim()
    const truncated =
      joined.length > HEADER_CHAR_CAP
        ? joined.slice(0, HEADER_CHAR_CAP).replace(/\s+\S*$/, "") + "\u2026"
        : joined
    return `${truncated}\n[full knowledge omitted — call search_catalog / explore_mssql_schema / inspect_definition]`
  }

  // Unmarked: first non-heading prose paragraph.
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  let first = paras.find((p) => !/^#{1,6}\s/.test(p)) ?? paras[0] ?? ""
  if (first.length > HEADER_CHAR_CAP) {
    first = first.slice(0, HEADER_CHAR_CAP).replace(/\s+\S*$/, "") + "\u2026"
  }
  return `${first}\n[full knowledge omitted — call search_catalog / explore_mssql_schema / inspect_definition]`
}

/** Pull `### \`schema\`` headings for a one-line namespace map. */
function packSchemaIndex(packs: ParsedKnowledgePacks): string {
  const names: string[] = []
  const re = /###\s+`([^`]+)`/g
  for (const block of [packs.meta, packs.mart]) {
    for (const m of block.matchAll(re)) {
      const name = m[1]?.trim()
      if (name && !names.includes(name)) names.push(name)
    }
  }
  if (names.length === 0) return ""
  return `Schemas covered in full knowledge: ${names.join(", ")}.`
}

/**
 * Render the selected pack(s) from a knowledge body.
 * Unmarked files: `meta`/`mart`/`both` → full body; `header` → header extract.
 */
export function renderKnowledgeSelection(
  body: string,
  selection: KnowledgePackSelection
): string {
  if (selection === "none" || !body.trim()) return ""

  const packs = parseKnowledgePacks(body)
  if (selection === "header") return extractKnowledgeHeader(body)

  if (!packs.marked) {
    // Custom/unmarked knowledge — never silently drop half the file.
    return packs.raw
  }

  const parts: string[] = []
  if (packs.shared) parts.push(packs.shared)
  if (selection === "meta" || selection === "both") {
    if (packs.meta) parts.push(packs.meta)
  }
  if (selection === "mart" || selection === "both") {
    if (packs.mart) parts.push(packs.mart)
  }
  return parts.join("\n\n---\n\n").trim()
}

/** True when rendered body still contains mart-only schema playbooks. */
export function knowledgeBodyHasMartProse(body: string): boolean {
  return /\b(?:publish\.|persistedView|dim\.|fact\.|RevenueZAR|pkMonth)\b/i.test(body)
}

/** True when rendered body still contains metadata-platform prose. */
export function knowledgeBodyHasMetaProse(body: string): boolean {
  return /\b(?:core\.|gate\.|agent\.vPipeline|vDataset|coreArchive)\b/i.test(body)
}

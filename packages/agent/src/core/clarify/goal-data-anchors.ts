/**
 * Goal data anchors — resolve WHERE the user's data lives.
 *
 * First-principles contract:
 *   - When the goal names a data source (schema.table, fuzzy typo, or
 *     globally-unique table name), that anchor is authoritative.
 *   - Descriptive words (financial, comprehensive, revenue-as-domain) are
 *     analysis intent, not table-picker cues — detectors must not ask_user
 *     to disambiguate them when anchors exist.
 *   - catalog search must scope by schema during ranking, not after top-N.
 *
 * Pure function of (goal, catalog, tenant mirrorSchema). No I/O.
 *
 * @module
 */

import { getTenantConfig } from "../../shell/tenant-config.js"
import { tokenize } from "../../../tools/catalog/helpers.js"
import type { CatalogGraph } from "../../../tools/catalog/graph/index.js"
import type { CatalogTable } from "../../../tools/catalog/types.js"
import { goalTokens } from "./detectors/stopwords.js"

/** `schema.object` — two-part SQL identifiers in goal text. */
export const QUALIFIED_NAME_RE = /\b([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)\b/g

export interface GoalDataAnchor {
  qualifiedName: string
  schema: string
  table: string
  resolution: "exact" | "mirror" | "fuzzy" | "unique-name"
}

export function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** True when `token` is how a user would name this table — not a buried substring. */
export function isPrimaryTableNameToken(tableName: string, token: string): boolean {
  const lower = tableName.toLowerCase()
  const singular = token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token
  if (lower === token || lower === singular || lower === `${singular}s`) return true
  const nameTokens = tokenize(tableName)
  if (nameTokens.length === 0) return false
  const head = nameTokens[0]!
  if (head === token || head === singular) return true
  if (nameTokens.length === 1 && nameTokens[0] === token) return true
  return false
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const row = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) row[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost)
      prev = tmp
    }
  }
  return row[n]!
}

function simplePluralVariants(token: string): string[] {
  if (token.endsWith("s")) return [token]
  if (token.endsWith("y") && token.length > 1) return [`${token.slice(0, -1)}ies`, `${token}s`]
  return [`${token}s`]
}

/**
 * Resolve `schema.object` against the catalog: exact (case-insensitive),
 * mirror (`<mirrorSchema>.schema.object`), then fuzzy within schema.
 */
export function resolveTableReference(
  catalog: CatalogGraph,
  schema: string,
  object: string,
  mirrorSchema?: string | null
): { table: CatalogTable; resolution: GoalDataAnchor["resolution"] } | null {
  const qname = `${schema}.${object}`
  const direct = catalog.getTable(qname)
  if (direct) return { table: direct, resolution: "exact" }

  const ms = mirrorSchema !== undefined ? mirrorSchema : getTenantConfig().mirrorSchema
  if (ms && !schema.toLowerCase().startsWith(`${ms.toLowerCase()}.`)) {
    const mirror = catalog.getTable(`${ms}.${qname}`)
    if (mirror) return { table: mirror, resolution: "mirror" }
  }

  const fuzzy = fuzzyTableInSchema(catalog, schema, object)
  if (fuzzy) return { table: fuzzy, resolution: "fuzzy" }
  return null
}

function fuzzyTableInSchema(catalog: CatalogGraph, schema: string, object: string): CatalogTable | null {
  const schemaLc = schema.toLowerCase()
  const want = normalizeIdentifier(object)
  if (want.length < 4) return null

  const candidates: Array<{ table: CatalogTable; distance: number }> = []
  for (const [, table] of catalog.tables) {
    if (table.schema.toLowerCase() !== schemaLc) continue
    const got = normalizeIdentifier(table.name)
    if (got === want) return table
    const maxDist = Math.max(2, Math.floor(want.length * 0.2))
    const distance = levenshtein(got, want)
    if (got.includes(want) || want.includes(got) || distance <= maxDist) {
      candidates.push({ table, distance })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.distance - b.distance || a.table.name.localeCompare(b.table.name))
  const best = candidates[0]!
  if (candidates.length === 1) return best.table
  const second = candidates[1]!
  if (best.distance < second.distance) return best.table
  return null
}

function uniquePrimaryTableMatch(catalog: CatalogGraph, token: string): CatalogTable | null {
  let found: CatalogTable | null = null
  for (const [, table] of catalog.tables) {
    if (!isPrimaryTableNameToken(table.name, token)) continue
    if (found) return null
    found = table
  }
  return found
}

/** Bare table anchors require identifier-shaped mention — not lowercase domain words. */
function appearsAsIdentifierInGoal(goal: string, token: string): boolean {
  const re = new RegExp(`\\b([A-Za-z][A-Za-z0-9]*)\\b`, "g")
  for (const m of goal.matchAll(re)) {
    const raw = m[1]!
    if (raw.toLowerCase() !== token) continue
    return raw !== raw.toLowerCase()
  }
  return false
}

function pushAnchor(
  anchors: GoalDataAnchor[],
  seen: Set<string>,
  table: CatalogTable,
  resolution: GoalDataAnchor["resolution"]
): void {
  const key = table.qualifiedName.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  anchors.push({
    qualifiedName: table.qualifiedName,
    schema: table.schema,
    table: table.name,
    resolution
  })
}

/**
 * All data sources the goal pins — qualified literals (incl. fuzzy/mirror)
 * plus globally-unique bare table names.
 */
export function resolveGoalDataAnchors(goal: string, catalog: CatalogGraph): GoalDataAnchor[] {
  const mirrorSchema = getTenantConfig().mirrorSchema
  const anchors: GoalDataAnchor[] = []
  const seen = new Set<string>()
  const consumedBare = new Set<string>()

  for (const m of goal.matchAll(QUALIFIED_NAME_RE)) {
    const schema = m[1]!
    const object = m[2]!
    consumedBare.add(schema.toLowerCase())
    consumedBare.add(object.toLowerCase())
    consumedBare.add(normalizeIdentifier(object))
    const resolved = resolveTableReference(catalog, schema, object, mirrorSchema)
    if (resolved) pushAnchor(anchors, seen, resolved.table, resolved.resolution)
  }

  for (const token of goalTokens(goal)) {
    if (token.length < 4) continue
    if (consumedBare.has(token) || consumedBare.has(normalizeIdentifier(token))) continue
    if (!appearsAsIdentifierInGoal(goal, token)) continue
    const table = uniquePrimaryTableMatch(catalog, token)
    if (table) pushAnchor(anchors, seen, table, "unique-name")
  }

  return anchors
}

/** Lowercase tokens consumed by resolved anchors (schema + table + plurals). */
export function anchorConsumedTokens(anchors: readonly GoalDataAnchor[]): Set<string> {
  const out = new Set<string>()
  for (const a of anchors) {
    out.add(a.schema.toLowerCase())
    out.add(a.table.toLowerCase())
    out.add(normalizeIdentifier(a.table))
    for (const variant of simplePluralVariants(a.table.toLowerCase())) out.add(variant)
  }
  return out
}

/** Adjective before analysis/report — "financial analysis", not a table name. */
export function isAnalysisDescriptor(goal: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `\\b${escaped}\\s+(analysis|analyses|summary|summaries|report|reports|overview|review|insights?)\\b`,
    "i"
  ).test(goal)
}

/**
 * When the goal already pins data source(s), suppress spurious table-picker
 * ambiguity on tokens that describe WHAT to do, not WHERE to read.
 */
export function shouldSuppressAmbiguousTokenGivenAnchors(
  token: string,
  goal: string,
  anchors: readonly GoalDataAnchor[],
  domainKeywords: readonly string[]
): boolean {
  if (anchors.length === 0) return false

  for (const anchor of anchors) {
    if (anchor.schema.toLowerCase() === token) return false
    if (isPrimaryTableNameToken(anchor.table, token)) return false
  }

  if (isAnalysisDescriptor(goal, token)) return true

  const kw = domainKeywords.find((k) => k.toLowerCase() === token)
  if (kw) return true

  return false
}

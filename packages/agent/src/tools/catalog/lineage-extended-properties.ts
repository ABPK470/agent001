/**
 * Read lineage curation from SQL Server EXTENDED_PROPERTIES.
 *
 * ── The contract (DBA-facing) ──────────────────────────────────────
 *
 * Curation lives next to the schema it describes. We use three
 * object-level (minor_id = 0) extended properties:
 *
 *   1. MS_Description           on a VIEW
 *      Value: a plain-text description of what the view represents.
 *      Maps to: ViewLineage.description
 *
 *   2. lineage_dim_joins        on a VIEW
 *      Value: JSON array of dim-join hints for the view's pk columns.
 *      Shape: [{"column":"pkClient","dimTable":"dim.Client",
 *              "dimRows":"~26M","note":"ALWAYS filter — never full scan"}]
 *      Maps to: ViewLineage.dimJoins
 *
 *   3. lineage_feeds            on a SOURCE VIEW or TABLE
 *      Value: JSON array — one element per PARENT view this source
 *      feeds into. The element carries the business framing of THIS
 *      source within THAT parent.
 *      Shape: [{"parent":"publish.Revenue",
 *               "businessArea":"Transactional Banking",
 *               "group":"Retail & Business Banking",
 *               "filter":"pkProduct IS NOT NULL AND Amount <> 0"},
 *              {"parent":"publish.RevenueDaily", ...}]
 *      Each element becomes one row in the parent's
 *      ViewLineage.sources[].
 *
 * Example T-SQL to author:
 *
 *   EXEC sp_addextendedproperty
 *     @name = N'lineage_feeds',
 *     @value = N'[{"parent":"publish.Revenue","businessArea":"...",
 *                  "group":"...","filter":"..."}]',
 *     @level0type = N'SCHEMA', @level0name = N'publish',
 *     @level1type = N'VIEW',   @level1name = N'MappingTransactionalBankingRules';
 *
 * ── Why "feeds" lives on the SOURCE, not the parent ────────────────
 *
 * Putting `lineage_feeds` on each source view means dropping or
 * renaming the source automatically removes its lineage assertion
 * (extended properties cascade with the object). Adding a new
 * source to a parent view is one `sp_addextendedproperty` on the
 * new source — no JSON file edits, no agent restart, no drift.
 *
 * ── Precedence ─────────────────────────────────────────────────────
 *
 * extended-properties > curation-file > auto-lineage
 *
 * Entries derived here are stamped `provenance: "extended-properties"`
 * and win against same-keyed entries from the JSON file (the file
 * load path skips views that already have an extended-property entry,
 * with a one-line warning telling the DBA the JSON entry is now
 * redundant and can be removed).
 *
 * ── Validation ─────────────────────────────────────────────────────
 *
 * These entries are read fresh from the live DB on every catalog
 * build, so the "stale references" class of drift (source dropped
 * but file not updated) cannot happen. We still pass them through
 * validateCuratedLineage() because a DBA might type a parent name
 * that doesn't exist as a view, or list a dimTable that was
 * renamed.
 */

import type { ConnectionPool } from "mssql"
import { Q_LINEAGE_PROPERTIES } from "./sql.js"
import type { LineageDimJoin, LineageSource, ViewLineage } from "./types.js"

interface RawPropertyRow {
  qualified_name:  string  // "publish.Revenue" or "publish.MappingFoo"
  object_type:     string  // 'U' (user table) or 'V' (view)
  property_name:   string  // 'MS_Description' | 'lineage_dim_joins' | 'lineage_feeds'
  property_value:  string  // raw NVARCHAR(MAX) — JSON for the lineage_* props, plain text for MS_Description
}

interface FeedEntry {
  parent:       string
  businessArea: string
  group:        string
  filter:       string
}

/**
 * Query the live DB for lineage-related extended properties and assemble
 * `ViewLineage[]` entries.
 *
 * Non-fatal: any parse error on a single property is logged and that
 * one property is skipped — the rest of the curation still loads.
 * Returns [] if the query fails entirely (e.g. permissions).
 */
export async function loadLineageFromExtendedProperties(
  pool: ConnectionPool,
  connectionName: string,
): Promise<ViewLineage[]> {
  let rows: RawPropertyRow[]
  try {
    const result = await pool.request().query(Q_LINEAGE_PROPERTIES)
    rows = result.recordset as RawPropertyRow[]
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[lineage:extprop] connection='${connectionName}' — query failed, skipping: ${(err as Error).message}`)
    return []
  }

  if (rows.length === 0) return []

  // Pass 1: bucket the raw rows by parent view we will be assembling.
  // - MS_Description on a VIEW seeds an assembly bucket for that view.
  // - lineage_dim_joins on a VIEW does the same.
  // - lineage_feeds on any object contributes one source to EACH parent
  //   listed in its JSON.
  const descriptions = new Map<string, string>()
  const dimJoinsByView = new Map<string, LineageDimJoin[]>()
  const sourcesByParent = new Map<string, LineageSource[]>()

  for (const r of rows) {
    if (r.property_name === "MS_Description") {
      // Only views participate in lineage; ignore MS_Description on tables here.
      // (Tables can carry MS_Description for other purposes — out of scope.)
      if (r.object_type === "V") descriptions.set(r.qualified_name, r.property_value.trim())
      continue
    }

    if (r.property_name === "lineage_dim_joins") {
      if (r.object_type !== "V") continue
      const parsed = parseJsonArray<LineageDimJoin>(r.qualified_name, r.property_name, r.property_value)
      if (parsed) dimJoinsByView.set(r.qualified_name, parsed)
      continue
    }

    if (r.property_name === "lineage_feeds") {
      const parsed = parseJsonArray<FeedEntry>(r.qualified_name, r.property_name, r.property_value)
      if (!parsed) continue
      for (const feed of parsed) {
        if (!feed.parent || typeof feed.parent !== "string") {
          // eslint-disable-next-line no-console
          console.warn(`[lineage:extprop] ${r.qualified_name} lineage_feeds entry missing 'parent' — skipping`)
          continue
        }
        const arr = sourcesByParent.get(feed.parent) ?? []
        arr.push({
          qualifiedName: r.qualified_name,
          businessArea:  feed.businessArea ?? "",
          group:         feed.group ?? "",
          filter:        feed.filter ?? "",
        })
        sourcesByParent.set(feed.parent, arr)
      }
    }
  }

  // Pass 2: every view that has ANY of (description, dimJoins, incoming feeds)
  // gets a ViewLineage entry.
  const parentSet = new Set<string>([
    ...descriptions.keys(),
    ...dimJoinsByView.keys(),
    ...sourcesByParent.keys(),
  ])

  const lineages: ViewLineage[] = []
  for (const view of parentSet) {
    lineages.push({
      view,
      description: descriptions.get(view) ?? "",
      outputColumns: [],   // not curated via extended properties — the catalog already knows the view's columns
      dimJoins: dimJoinsByView.get(view) ?? [],
      sources: sourcesByParent.get(view) ?? [],
      provenance: "extended-properties",
    })
  }

  // eslint-disable-next-line no-console
  console.log(`[lineage:extprop] connection='${connectionName}' assembled ${lineages.length} lineage entries from ${rows.length} extended properties`)

  return lineages
}

/**
 * Parse a JSON array property value safely. Logs and returns null on any
 * shape mismatch — a single broken property never poisons the rest of
 * the load.
 */
function parseJsonArray<T>(qualifiedName: string, propertyName: string, rawValue: string): T[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[lineage:extprop] ${qualifiedName}.${propertyName} is not valid JSON: ${(err as Error).message}`)
    return null
  }
  if (!Array.isArray(parsed)) {
    // eslint-disable-next-line no-console
    console.warn(`[lineage:extprop] ${qualifiedName}.${propertyName} JSON is not an array — expected [{...},{...}]`)
    return null
  }
  return parsed as T[]
}

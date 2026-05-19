#!/usr/bin/env node
/**
 * Emit `sp_addextendedproperty` T-SQL that migrates the curation in
 * `deploy/mssql/lineage.json` into SQL Server EXTENDED_PROPERTIES on the
 * live database — the north-star source for lineage curation (see
 * packages/agent/src/tools/catalog/lineage-extended-properties.ts for the
 * full contract).
 *
 * Why a script (not auto-apply): extended properties touch the production
 * schema. The DBA must review the emitted SQL, run it in a transaction in
 * a non-prod environment first, and verify the catalog rebuild picks up
 * the new properties (boot log: `[lineage:extprop] connection='…'
 * assembled N lineage entries`). Once a view is migrated, its entry can
 * be removed from lineage.json — the agent's catalog-build pipeline
 * already prefers extended-properties over the JSON file and warns on
 * redundancy.
 *
 * Mapping (one statement per object/property):
 *   description     → MS_Description     on the parent VIEW
 *   dimJoins        → lineage_dim_joins  on the parent VIEW (JSON array)
 *   sources[]       → lineage_feeds      on EACH SOURCE view/table
 *                                         (JSON array; one element per
 *                                          parent view that source feeds)
 *
 * Usage:
 *   node scripts/lineage-to-extended-properties.mjs                # prints SQL to stdout
 *   node scripts/lineage-to-extended-properties.mjs > migrate.sql  # save for review
 *   node scripts/lineage-to-extended-properties.mjs --view publish.Revenue
 *                                                   # emit only one parent's SQL
 *
 * NOTE: this script does NOT connect to a database. It only reads the
 * JSON file and emits SQL. Review and apply manually.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const LINEAGE_PATH = resolve(process.cwd(), "deploy/mssql/lineage.json")

const args = process.argv.slice(2)
const viewFilter = args.includes("--view") ? args[args.indexOf("--view") + 1] : null

const lineages = JSON.parse(readFileSync(LINEAGE_PATH, "utf-8"))

/**
 * Split "schema.object" → ["schema", "object"]. Returns null if the input
 * is not in the expected two-part form (one-part names cannot be addressed
 * by sp_addextendedproperty's @level1name without a default schema).
 */
function splitName(qualified) {
  const idx = qualified.indexOf(".")
  if (idx <= 0 || idx === qualified.length - 1) return null
  return [qualified.slice(0, idx), qualified.slice(idx + 1)]
}

/** Escape single quotes for T-SQL NVARCHAR literals. */
function tsqlString(s) {
  return `N'${String(s).replace(/'/g, "''")}'`
}

/**
 * Emit sp_addextendedproperty for an OBJECT-level (level 0=SCHEMA,
 * level 1=VIEW|TABLE) property. Uses `IF NOT EXISTS` + sp_updateextendedproperty
 * fallback so the script is safe to re-run (idempotent).
 */
function emitObjectProperty(qualified, objectKind, propertyName, propertyValue) {
  const parts = splitName(qualified)
  if (!parts) {
    console.error(`-- SKIP: ${qualified} is not a two-part name (schema.object) — sp_addextendedproperty requires both.`)
    return
  }
  const [schema, object] = parts
  const valueLiteral = tsqlString(propertyValue)
  const propName = tsqlString(propertyName)
  const schemaLit = tsqlString(schema)
  const objectLit = tsqlString(object)
  const kindLit = tsqlString(objectKind)  // 'VIEW' | 'TABLE'

  console.log(`
-- ${qualified}.${propertyName}
IF EXISTS (
  SELECT 1 FROM sys.extended_properties ep
  JOIN sys.objects o  ON ep.major_id = o.object_id
  JOIN sys.schemas s  ON o.schema_id = s.schema_id
  WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = ${propName}
    AND s.name = ${schemaLit} AND o.name = ${objectLit}
)
  EXEC sp_updateextendedproperty
    @name = ${propName}, @value = ${valueLiteral},
    @level0type = N'SCHEMA', @level0name = ${schemaLit},
    @level1type = ${kindLit}, @level1name = ${objectLit};
ELSE
  EXEC sp_addextendedproperty
    @name = ${propName}, @value = ${valueLiteral},
    @level0type = N'SCHEMA', @level0name = ${schemaLit},
    @level1type = ${kindLit}, @level1name = ${objectLit};
GO`)
}

// Per-source feeds: { sourceQualifiedName → [{ parent, businessArea, group, filter }] }
const feedsBySource = new Map()

let parentsEmitted = 0
let dimsEmitted = 0
let descriptionsEmitted = 0

for (const entry of lineages) {
  if (viewFilter && entry.view !== viewFilter) continue
  parentsEmitted++

  // 1. Parent VIEW: MS_Description
  if (entry.description) {
    emitObjectProperty(entry.view, "VIEW", "MS_Description", entry.description)
    descriptionsEmitted++
  }

  // 2. Parent VIEW: lineage_dim_joins (JSON array)
  if (Array.isArray(entry.dimJoins) && entry.dimJoins.length > 0) {
    emitObjectProperty(entry.view, "VIEW", "lineage_dim_joins", JSON.stringify(entry.dimJoins))
    dimsEmitted++
  }

  // 3. Accumulate per-source feeds; each source may feed multiple parents.
  if (Array.isArray(entry.sources)) {
    for (const src of entry.sources) {
      if (!src.qualifiedName) continue
      const arr = feedsBySource.get(src.qualifiedName) ?? []
      arr.push({
        parent: entry.view,
        businessArea: src.businessArea ?? "",
        group: src.group ?? "",
        filter: src.filter ?? "",
      })
      feedsBySource.set(src.qualifiedName, arr)
    }
  }
}

// 4. Emit one lineage_feeds property per source (after accumulation, so
//    sources that feed multiple parents get a single multi-element JSON
//    array instead of overwriting themselves).
let feedsEmitted = 0
for (const [source, feeds] of feedsBySource) {
  // Source object kind is unknown to this script (tables vs views differ);
  // we always emit as VIEW since the curated sources here are publish.* views.
  // For a mixed input the script would need a kind hint from the catalog —
  // out of scope for the one-shot migration.
  emitObjectProperty(source, "VIEW", "lineage_feeds", JSON.stringify(feeds))
  feedsEmitted++
}

console.error(
  `-- summary: parents=${parentsEmitted}, descriptions=${descriptionsEmitted}, ` +
  `dim_joins=${dimsEmitted}, source_objects_with_feeds=${feedsEmitted}, ` +
  `source_object_kind_assumption=VIEW (edit @level1type for any TABLE sources)`,
)

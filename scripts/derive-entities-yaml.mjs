#!/usr/bin/env node
/**
 * Derive `deploy/mssql/entities/_all.yaml` from `deploy/mssql/sync-recipes.json`.
 *
 * The recipe JSON is the as-introspected ground truth from the legacy MyMI
 * pipelines + FK graph. This script reshapes it into the entity-registry
 * `EntityDefinition` YAML format used by the on-boot seed importer
 * (`packages/server/src/sync/entity-bootstrap.ts`), preserving ALL fields
 * (no diagnostic data dropped). Re-run after any change to sync-recipes.json.
 *
 * Usage:
 *   node scripts/derive-entities-yaml.mjs
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stringify } from "yaml"

const ROOT = resolve(fileURLToPath(import.meta.url), "../..")
const RECIPES_PATH = resolve(ROOT, "deploy/mssql/sync-recipes.json")
const OUT_PATH = resolve(ROOT, "deploy/mssql/entities/_all.yaml")

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Slugify a camelCase or PascalCase identifier into kebab-case to satisfy
 * the entity-registry id validator (`/^[a-z][a-z0-9_-]{0,63}$/`).
 *
 *   gateMetadata     → gate-metadata
 *   pipelineActivity → pipeline-activity
 *   content          → content (untouched — already lowercase)
 */
function toKebab(id) {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
}

/** Derive the scope kind+payload from a recipe table row. */
function scopeFor(row, rootKeyColumn) {
  // If predicate is a simple `<col> = {id}` against the root key, it's rootPk.
  const simple = /^([A-Za-z_][\w]*)\s*=\s*\{id\}\s*$/.exec(row.predicate ?? "")
  if (simple && simple[1] === rootKeyColumn) {
    return { kind: "rootPk", column: simple[1] }
  }
  // If predicate is `<col> = {id}` against a non-root column (e.g. table is the
  // root itself but uses a different column), still rootPk on that column.
  if (simple) {
    return { kind: "rootPk", column: simple[1] }
  }
  // Otherwise it's a SQL predicate (joins or IN-subselects).
  return { kind: "sql", predicate: row.predicate }
}

/** Map a recipe table row → EntityTable YAML object. */
function tableFor(row, idx, rootKeyColumn, legacyPipelineId) {
  const out = {
    name: row.name,
    scope: scopeFor(row, rootKeyColumn),
    executionOrder: idx,
    verified: Boolean(row.verified),
  }
  if (row.scopeColumn) out.scopeColumn = row.scopeColumn
  if (row.source) out.source = row.source
  if (typeof row.groundedByPipeline === "boolean") out.groundedByPipeline = row.groundedByPipeline
  if (typeof row.enabledByDefault === "boolean") out.enabledByDefault = row.enabledByDefault
  if (typeof row.userControllable === "boolean") out.userControllable = row.userControllable
  if (row.note) out.note = row.note
  out.provenance = legacyPipelineId
    ? { kind: "legacy-migration", legacyPipelineId }
    : { kind: "manual" }
  return out
}

/** Reshape one recipe → EntityDefinition shape (no server-stamped fields). */
function entityFor(recipeId, recipe) {
  const rootKeyColumn = recipe.rootKeyColumn
  // Use recipe.executionOrder for ordering; map back to per-table rows.
  const tableByName = new Map(recipe.tables.map((t) => [t.name, t]))
  const orderedTables = recipe.executionOrder.map((name, idx) => {
    const row = tableByName.get(name)
    if (!row) throw new Error(`recipe ${recipeId}: executionOrder references missing table ${name}`)
    return tableFor(row, idx, rootKeyColumn, recipe.legacyPipelineId ?? null)
  })

  const description = describe(recipeId, recipe)

  const entity = {
    id: toKebab(recipeId),
    tenantId: "_default",
    displayName: recipe.displayName,
    description,
    rootTable: recipe.rootTable,
    idColumn: rootKeyColumn,
  }
  if (recipe.rootNameColumn) entity.labelColumn = recipe.rootNameColumn
  if (recipe.selfJoinColumn) entity.selfJoinColumn = recipe.selfJoinColumn

  entity.scd2 = { strategyId: "mymi-scd2", strategyVersion: "latest" }
  entity.tables = orderedTables
  entity.policies = {
    approvalPolicyId: null,
    freezeWindowIds: [],
    riskMultiplier: 1.0,
  }
  entity.provenance = recipe.legacyPipelineId
    ? { kind: "legacy-migration", legacyPipelineId: recipe.legacyPipelineId }
    : { kind: "manual" }
  if (recipe.legacyEntrySproc) entity.legacyEntrySproc = recipe.legacyEntrySproc
  if (Array.isArray(recipe.reverseOrder) && recipe.reverseOrder.length > 0) {
    entity.reverseOrder = recipe.reverseOrder
  }
  if (Array.isArray(recipe.discrepancies) && recipe.discrepancies.length > 0) {
    entity.discrepancies = recipe.discrepancies
  }
  return entity
}

/** Human-readable description for the entity. */
function describe(id, recipe) {  const counts = recipe.tables.length
  const verified = recipe.tables.filter((t) => t.verified).length
  const pipelineRef = recipe.legacyPipelineId
    ? ` Derived from legacy MyMI pipeline ${recipe.legacyPipelineId} (${recipe.legacyEntrySproc ?? "n/a"}).`
    : ""
  return `${recipe.displayName} entity covering ${counts} tables (${verified} verified) rooted at ${recipe.rootTable}.${pipelineRef}`
}

// ── main ───────────────────────────────────────────────────────────

function main() {
  const raw = JSON.parse(readFileSync(RECIPES_PATH, "utf8"))
  if (!raw.recipes || typeof raw.recipes !== "object") {
    throw new Error(`${RECIPES_PATH}: missing 'recipes' object`)
  }
  const entityIds = Object.keys(raw.recipes).sort()
  const entities = entityIds.map((id) => entityFor(id, raw.recipes[id]))

  const header = [
    `# Auto-generated by scripts/derive-entities-yaml.mjs`,
    `# Source: deploy/mssql/sync-recipes.json`,
    `# Introspected from: ${raw.introspectedFrom ?? "(unknown)"}`,
    `# Generated at: ${raw.generatedAt ?? "(unknown)"}`,
    `# Do NOT hand-edit — re-run the script after updating sync-recipes.json.`,
    "",
  ].join("\n")

  const yamlDocs = entities.map((e) => "---\n" + stringify(e, { lineWidth: 0, sortMapEntries: false })).join("")

  writeFileSync(OUT_PATH, header + yamlDocs)
  // eslint-disable-next-line no-console
  console.log(`wrote ${entities.length} entities → ${OUT_PATH}`)
  for (const e of entities) {
    // eslint-disable-next-line no-console
    console.log(`  - ${e.id} (${e.tables.length} tables)`)
  }
}

main()

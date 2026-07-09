/**
 * Resolve legacy generator review placeholders into catalog-grounded SQL scopes.
 *
 * Used at artifact import and should stay aligned with
 * deploy/sync/helpers/legacy-entity-derivation.mjs.
 */

export interface ScopeResolveContext {
  rootTable: string
  idColumn: string
  selfJoinColumn: string | null
  tableName: string
  scopeColumn: string | null
}

function quoteTable(name: string): string {
  const parts = name.split(".")
  if (parts.length === 2) {
    return `[${parts[0]!.replace(/]/g, "]]")}].[${parts[1]!.replace(/]/g, "]]")}]`
  }
  return `[${name.replace(/]/g, "]]")}]`
}

function quoteColumn(column: string): string {
  return `[${column.replace(/]/g, "]]")}]`
}

function idToken(selfJoinColumn: string | null): "{id}" | "{ids}" {
  return selfJoinColumn?.trim() ? "{ids}" : "{id}"
}

function hasReviewPlaceholder(predicate: string): boolean {
  return /\/\*[\s\S]*?\*\//.test(predicate) || /\breview\b/i.test(predicate)
}

/** True when a predicate is structurally unusable at preview time. */
export function looksIncompleteScopePredicate(predicate: string): boolean {
  if (typeof predicate !== "string" || predicate.trim().length === 0) return true
  if (hasReviewPlaceholder(predicate)) return true
  if (/\bIN\s*\(\s*\)/i.test(predicate)) return true
  return false
}

/**
 * Derive a concrete scope from known legacy pipeline-variable patterns.
 * Returns null when the table must be reviewed manually against the entry sproc.
 */
export function resolveReviewPlaceholderPredicate(
  predicate: string,
  ctx: ScopeResolveContext,
): string | null {
  if (!looksIncompleteScopePredicate(predicate)) return predicate.trim()

  const tableKey = ctx.tableName.toLowerCase()
  const column = ctx.scopeColumn?.trim()
  if (!column) return null

  const ids = idToken(ctx.selfJoinColumn)
  const root = quoteTable(ctx.rootTable)
  const rootId = quoteColumn(ctx.idColumn)

  switch (tableKey) {
    case "gate.contenttype":
      if (column === "contentTypeId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn(column)} FROM ${quoteTable("gate.Content")} WHERE ${quoteColumn("contentId")} IN (${ids}))`
      }
      break
    case "gate.contentlinktype":
      if (column === "contentLinkTypeId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn(column)} FROM ${quoteTable("gate.ContentLink")} WHERE ${quoteColumn("contentId")} IN (${ids}))`
      }
      break
    case "gate.jsonschema":
      if (column === "jsonSchemaId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn(column)} FROM ${root} WHERE ${rootId} = {id} AND ${quoteColumn(column)} IS NOT NULL)`
      }
      break
    case "core.dataset":
      if (column === "datasetId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn("inputDatasetId")} FROM ${quoteTable("core.Rule")} WHERE ${quoteColumn("ruleId")} IN (${ids}) AND ${quoteColumn("inputDatasetId")} IS NOT NULL)`
      }
      break
    case "core.datasetcolumn":
      if (column === "datasetId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn("inputDatasetId")} FROM ${quoteTable("core.Rule")} WHERE ${quoteColumn("ruleId")} IN (${ids}) AND ${quoteColumn("inputDatasetId")} IS NOT NULL)`
      }
      break
    case "core.datasetmapping":
    case "core.datasetmappingcolumn":
      if (column === "datasetMappingId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT dm.${quoteColumn("datasetMappingId")} FROM ${quoteTable("core.DatasetMapping")} dm INNER JOIN ${quoteTable("core.Rule")} r ON r.${quoteColumn("inputDatasetId")} = dm.${quoteColumn("datasetId_Left")} WHERE r.${quoteColumn("ruleId")} IN (${ids}) AND dm.${quoteColumn("datasetMappingId")} IS NOT NULL)`
      }
      break
    case "core.rulelinktype":
      if (column === "ruleLinkTypeId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn("ruleLinkTypeId")} FROM ${quoteTable("core.RuleLink")} WHERE ${quoteColumn("ruleId")} IN (${ids}) AND ${quoteColumn("ruleLinkTypeId")} IS NOT NULL)`
      }
      break
    case "core.ruletype":
      if (column === "ruleTypeId") {
        return `${quoteColumn(column)} IN (SELECT DISTINCT ${quoteColumn("ruleTypeId")} FROM ${root} WHERE ${quoteColumn("ruleId")} IN (${ids}) AND ${quoteColumn("ruleTypeId")} IS NOT NULL)`
      }
      break
    default:
      break
  }

  return null
}

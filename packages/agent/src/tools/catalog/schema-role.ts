/**
 * Schema lifecycle roles — universal deprioritization for snapshot / staging
 * schemas without per-tenant prompt hacks.
 */

export type SchemaRole = "analytic" | "dwh-archive" | "ops-archive" | "staging" | "neutral"

const ANALYTIC_SCHEMAS = new Set([
  "publish",
  "persistedview",
  "dim",
  "fact",
  "list",
  "ext"
])

const STAGING_SCHEMAS = new Set(["etl", "map", "staging"])

/** Default score penalty layered on top of tenant schemaRanking. */
export function defaultSchemaRolePenalty(role: SchemaRole): number {
  switch (role) {
    case "dwh-archive":
      return -50
    case "staging":
      return -25
    case "ops-archive":
      return -10
    default:
      return 0
  }
}

export function classifySchemaRole(schema: string): SchemaRole {
  const lc = schema.toLowerCase()
  if (lc === "archive") return "dwh-archive"
  if (/archive$/i.test(schema) && lc !== "archive") return "ops-archive"
  if (STAGING_SCHEMAS.has(lc)) return "staging"
  if (ANALYTIC_SCHEMAS.has(lc) || lc.startsWith("persistedview")) return "analytic"
  return "neutral"
}

export function isDwhArchiveSchema(schema: string): boolean {
  return classifySchemaRole(schema) === "dwh-archive"
}

/** Suppress row-count bonus for snapshot stores — volume ≠ analytic importance. */
export function rowCountBonusForSchema(schema: string, rowCount: number | null | undefined): number {
  if (!rowCount || isDwhArchiveSchema(schema)) return 0
  return Math.min(Math.log10(rowCount + 1) * 2, 20)
}

/**
 * Whether a table should appear in ask_user / clarify entity options for
 * analytic (BI) goals. DWH archive is excluded unless explicitly named.
 */
export function isAnalyticEntityCandidate(
  qualifiedName: string,
  context: { goalMentionsArchive?: boolean; goalPinsQualifiedName?: boolean } = {}
): boolean {
  const schema = qualifiedName.includes(".") ? qualifiedName.split(".")[0]! : qualifiedName
  const role = classifySchemaRole(schema)
  if (role === "dwh-archive") {
    return context.goalMentionsArchive === true || context.goalPinsQualifiedName === true
  }
  return true
}

export function schemaTierSortKey(schema: string, tenantWeight = 0): number {
  const role = classifySchemaRole(schema)
  const roleBase =
    role === "analytic"
      ? 100
      : role === "neutral"
        ? 40
        : role === "ops-archive"
          ? 20
          : role === "staging"
            ? 10
            : 0
  return roleBase + tenantWeight
}

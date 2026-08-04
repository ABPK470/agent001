import type { AmbiguityFinding, ClarificationRequirement } from "@mia/agent"

export type ToolOperation = "discovery" | "data-read" | "mutation"

/**
 * A finding only stops the operation whose result would commit to its unknown
 * meaning. Discovery remains available so the agent can gather evidence rather
 * than asking the user for facts the runtime can determine itself.
 */
export function requirementForFinding(
  finding: Pick<AmbiguityFinding, "kind" | "severity">
): ClarificationRequirement {
  if (finding.severity !== "block") return "none"
  return finding.kind === "write-confirmation" ? "before-mutation" : "before-data-read"
}

/**
 * Classifies the operation, not the tool's name alone. Unknown operations are
 * treated as mutations so newly introduced tools are protected until their
 * capability is deliberately declared here.
 */
export function operationForTool(name: string, args: Record<string, unknown>): ToolOperation {
  if (name === "query_mssql") return operationForSql(String(args["query"] ?? args["sql"] ?? ""))
  if (DISCOVERY_TOOLS.has(name)) return "discovery"
  if (DATA_READ_TOOLS.has(name)) return "data-read"
  return "mutation"
}

export function blocksOperation(requirement: ClarificationRequirement, operation: ToolOperation): boolean {
  if (requirement === "none" || operation === "discovery") return false
  if (requirement === "before-data-read") return operation === "data-read" || operation === "mutation"
  return operation === "mutation"
}

function operationForSql(sql: string): ToolOperation {
  const statement = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, "").toUpperCase()
  return /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|EXEC(?:UTE)?\b)/.test(statement)
    ? "mutation"
    : "data-read"
}

const DISCOVERY_TOOLS = new Set([
  "ask_user",
  "think",
  "read_file",
  "list_directory",
  "search_files",
  "explore_mssql_schema",
  "search_catalog",
  "discover_relationships",
  "inspect_definition",
  "list_adapters",
  "list_sync_definitions",
  "resolve_sync_scope",
  "search_sync_entities",
  "list_environments",
  "list_attachments",
  "read_attachment",
  "recall_prior_result",
  "check_messages"
])

const DATA_READ_TOOLS = new Set([
  "profile_data",
  "export_query_to_file",
  "fetch_url",
  "get_chart_specs",
  "compare_catalogs",
  "sync_preview",
  "sync_diff_scan"
])

/**
 * Tool registry — single source of truth for all available agent tools.
 *
 * Agent definitions select a subset of these by name.
 * The registry is populated once at startup; the tools themselves
 * are stateless (workspace path is set globally via setBasePath).
 */

import {
    appendFileTool,
    askUserTool,
    browserCheckTool,
    browseWebTool,
    compareCatalogsTool,
    createDelegateTools,
    discoverRelationshipsTool,
    exportQueryToFileTool,
    fetchUrlTool,
    importAttachmentTool,
    inspectDefinitionTool,
    listAttachmentsTool,
    listDirectoryTool,
    listEnvironmentsTool,
    mssqlSchemaTool,
    mssqlTool,
    profileDataTool,
    readAttachmentTool,
    readFileTool,
    replaceInFileTool,
    searchCatalogTool,
    searchFilesTool,
    shellTool,
    syncExecuteTool,
    syncPreviewTool,
    thinkTool,
    writeFileTool,
    type LLMClient,
    type Tool,
} from "@agent001/agent"
import { AgentBus, createBusTools } from "./agent-bus.js"

export { thinkTool }

export interface ToolInfo {
  name: string
  description: string
}

const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  appendFileTool,
  replaceInFileTool,
  listDirectoryTool,
  searchFilesTool,
  shellTool,
  fetchUrlTool,
  browserCheckTool,
  browseWebTool,
  askUserTool,
  mssqlTool,
  mssqlSchemaTool,
  exportQueryToFileTool,
  discoverRelationshipsTool,
  profileDataTool,
  inspectDefinitionTool,
  searchCatalogTool,
  // ── ABI environment sync ──
  compareCatalogsTool,
  syncPreviewTool,
  syncExecuteTool,
  listEnvironmentsTool,
  // ── Attachments (hosted-MIA Phase 4) ──
  listAttachmentsTool,
  readAttachmentTool,
  importAttachmentTool,
]

const toolMap = new Map<string, Tool>(ALL_TOOLS.map((t) => [t.name, t]))
// thinkTool is not in ALL_TOOLS (won't appear in listings) but stays resolvable
// so existing agent definitions that reference it don't crash.
toolMap.set(thinkTool.name, thinkTool)

const catalogLlm: LLMClient = {
  async chat() {
    return {
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }
  },
}

function listRuntimeCatalogTools(): Tool[] {
  const catalog = new Map<string, Tool>()

  for (const tool of toolMap.values()) catalog.set(tool.name, tool)

  const delegateTools = createDelegateTools({
    llm: catalogLlm,
    availableTools: [...ALL_TOOLS],
    depth: 0,
    maxDepth: 1,
    resolveAgent: () => null,
  })
  for (const tool of delegateTools) catalog.set(tool.name, tool)

  const busTools = createBusTools(new AgentBus("catalog"), "catalog", "Catalog Agent")
  for (const tool of busTools) catalog.set(tool.name, tool)

  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Get all registered tools as a Map. */
export function getToolMap(): ReadonlyMap<string, Tool> {
  return toolMap
}

/**
 * Tools that guard messages, formatter warnings, or prompt sections explicitly
 * direct the model to use as a fallback. If any of these are missing from an
 * agent's resolved whitelist, the guard messages will reference a tool the
 * model cannot actually call — producing infinite loops where the model retries
 * the blocked path because it has no alternative.
 *
 * When you add a new guard message that says "use X instead", add X here.
 */
const GUARD_REFERENCED_TOOLS: ReadonlyArray<{ name: string; referencedBy: string }> = [
  { name: "export_query_to_file", referencedBy: "mssql formatter ROW LIMIT/TRUNCATION warnings, query_mssql tool description, write_file anti-paste guard" },
]

/**
 * Validate that every tool referenced by guard messages/prompts is present in
 * the resolved set. Logs a loud warning (not a throw) so a deliberately-trimmed
 * agent doesn't hard-fail at construction, but the operator sees the gap.
 */
function warnOnMissingGuardTools(resolvedNames: ReadonlySet<string>): void {
  for (const { name, referencedBy } of GUARD_REFERENCED_TOOLS) {
    if (!resolvedNames.has(name)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tools] WARNING: tool "${name}" is NOT in this agent's whitelist, ` +
        `but is referenced by: ${referencedBy}. ` +
        `The model will be told to call "${name}" as a fallback and will loop because the tool is unavailable. ` +
        `Either add "${name}" to the agent's tools, or remove the guard reference.`,
      )
    }
  }
}

/** Resolve an array of tool names into Tool objects. Throws on unknown names. */
export function resolveTools(names: string[]): Tool[] {
  const resolved = names.map((name) => {
    const tool = toolMap.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool
  })
  warnOnMissingGuardTools(new Set(resolved.map((t) => t.name)))
  return resolved
}

/** List all available tool names + descriptions (for API/UI). */
export function listAvailableTools(): ToolInfo[] {
  return listRuntimeCatalogTools().map((t) => ({ name: t.name, description: t.description }))
}

/** Get all registered tools as an array. */
export function getAllTools(): Tool[] {
  return [...ALL_TOOLS]
}

/**
 * Tools available to non-admin "visitor" users. NO `shellTool` (no shell
 * access from chat), NO `browseWebTool` (no headless-browser side effects).
 * Read/write filesystem stays scoped to the run's sandbox by existing
 * filesystem-security checks.
 *
 * ABI sync tools (list_environments, sync_preview, sync_execute,
 * compare_catalogs) ARE included here because the system prompt always
 * injects the ABI sync guidance. A mismatch — system prompt says "use
 * sync_preview" but the tool is absent from the LLM schema — causes the
 * agent to fall back to asking for clarification instead of executing.
 * Sync tools are read/preview-safe; sync_execute requires explicit
 * user confirmation via planId, so the safety rail is the plan TTL and
 * the confirmation step, not tool-level exclusion.
 */
const VISITOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "append_file",
  "replace_in_file",
  "list_directory",
  "search_files",
  "think",
  "fetch_url",
  "ask_user",
  "search_catalog",
  "query_mssql",
  "explore_mssql_schema",
  "export_query_to_file",
  "discover_relationships",
  "profile_data",
  "inspect_definition",
  // ABI sync — must match what the system prompt advertises
  "list_environments",
  "sync_preview",
  "sync_execute",
  "compare_catalogs",
  // Attachments (hosted-MIA Phase 4)
  "list_attachments",
  "read_attachment",
  "import_attachment",
])

/** Filter a tool list down to the visitor allowlist. */
export function filterToolsForVisitor(tools: Tool[]): Tool[] {
  return tools.filter((t) => VISITOR_TOOL_NAMES.has(t.name))
}

/** Returns true if the named tool is in the visitor allowlist. */
export function isVisitorTool(name: string): boolean {
  return VISITOR_TOOL_NAMES.has(name)
}

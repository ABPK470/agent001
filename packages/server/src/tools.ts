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
    bindNoteTool,
    bindRecordTableVerdictTool,
    browserAutoLoginTool,
    browserCheckTool,
    browserHumanHandoffTool,
    browseWebTool,
    compareCatalogsTool,
    createDelegateTools,
    discoverRelationshipsTool,
    exportQueryToFileTool,
    fetchUrlTool,
    getChartSpecsTool,
    importAttachmentTool,
    inspectDefinitionTool,
    listAttachmentsTool,
    listDirectoryTool,
    listEnvironmentsTool,
    mssqlSchemaTool,
    mssqlTool,
    noteTool,
    profileDataTool,
    promoteAttachmentTool,
    readAttachmentTool,
    readFileTool,
    recordTableVerdictTool,
    replaceInFileTool,
    searchCatalogTool,
    searchFilesTool,
    shellTool,
    syncExecuteTool,
    syncPreviewTool,
    thinkTool,
    webSearchTool,
    writeFileTool,
    type DelegateContext,
    type GovernToolOptions,
    type LLMClient,
    type Tool,
} from "@mia/agent"
import { AgentBus, createBusTools } from "./agent-bus.js"
import { ingestAgentNote, recordTableVerdict } from "./memory/index.js"

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
  browserAutoLoginTool,
  browserHumanHandoffTool,
  webSearchTool,
  askUserTool,
  getChartSpecsTool,
  thinkTool,
  noteTool,
  recordTableVerdictTool,
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
  promoteAttachmentTool,
]

// Single source of truth: every static tool lives in ALL_TOOLS. The toolMap is
// a name-keyed view used by agent definitions and runtime resolution.
const toolMap = new Map<string, Tool>(ALL_TOOLS.map((t) => [t.name, t]))

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
  "note",
  "record_table_verdict",
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
  "promote_attachment",
])

/** Filter a tool list down to the visitor allowlist. */
export function filterToolsForVisitor(tools: Tool[]): Tool[] {
  return tools.filter((t) => VISITOR_TOOL_NAMES.has(t.name))
}

/** Returns true if the named tool is in the visitor allowlist. */
export function isVisitorTool(name: string): boolean {
  return VISITOR_TOOL_NAMES.has(name)
}

// ── Per-run tool registry ────────────────────────────────────────
// Static tools (above) live in ALL_TOOLS and are stateless. A second class
// of tools must be constructed fresh per run because they close over run-
// scoped state: delegation (parent run-id, depth, child usage tracking),
// inter-agent bus (run-id + agent name), and ask_user (the pending-input
// resolver tied to this run's controller). Rather than re-concatenating
// these in run-executor every time we add a category, declare them once
// here as a list of factories and let `composePerRunTools` assemble the
// final array. This is the single source of truth for "what tools exist
// at runtime"; see `listRuntimeCatalogTools` for the catalog-mode mirror.

export interface PerRunToolContext {
  runId: string
  agentName: string
  bus: AgentBus
  delegateCtx: DelegateContext
  /**
   * Wraps a tool with run-scoped governance. The caller binds services,
   * state, and the abort signal at construction; the factory only chooses
   * per-tool overrides like timeoutMs.
   */
  govern: (tool: Tool, opts?: Pick<GovernToolOptions, "timeoutMs">) => Tool
  /**
   * Resolves an ask_user prompt by recording the question, broadcasting
   * UserInputRequired, and waiting for the user's response. The factory
   * doesn't need to know about pendingInputs or SSE plumbing.
   */
  askUserResolve: (question: string, options: string[] | undefined, sensitive: boolean) => Promise<string>
  /**
   * Run-scoped identifiers needed by the `note` tool factory so agent-authored
   * memory writes carry correct tenant + session provenance. May be null when
   * the run is anonymous or pre-session (rare; the note will still be stored
   * but won't be retrievable via session-scoped working-memory queries).
   */
  sessionId: string | null
  upn: string | null
}

export type PerRunToolFactory = (ctx: PerRunToolContext) => Tool[]

/**
 * Ordered list of factories that produce per-run tools. Each factory is
 * pure: given a context it returns Tool[]. Adding a new category of run-
 * scoped tools means appending here, not editing run-executor.
 */
export const PER_RUN_FACTORIES: PerRunToolFactory[] = [
  // delegate / delegate_parallel — needs full DelegateContext (LLM, parent
  // tools, depth, child trace/usage hooks, queue slot acquirer).
  (ctx) => createDelegateTools(ctx.delegateCtx),
  // bus tools (send_message, check_messages, etc.) — needs the run-id and
  // the agent's display name so messages are attributed correctly.
  (ctx) => createBusTools(ctx.bus, ctx.runId, ctx.agentName),
  // ask_user — governance applied with timeoutMs:0 because the tool blocks
  // until a human responds; the default racer would kill it.
  (ctx) => [
    ctx.govern(
      {
        ...askUserTool,
        execute: async (args) => {
          const question = String(args["question"] ?? "")
          if (!question) return "Error: 'question' is required"
          const options = Array.isArray(args["options"]) ? args["options"].map(String) : undefined
          const sensitive = Boolean(args["sensitive"])
          return ctx.askUserResolve(question, options, sensitive)
        },
      },
      { timeoutMs: 0 },
    ),
  ],
  // note — agent-authored memory write. Closes over run ids + tenant so the
  // server's ingestAgentNote stamps the entry with correct provenance.
  // Governance is left at defaults; ingestion is a quick DB write.
  (ctx) => [
    ctx.govern(
      bindNoteTool(async (payload) => {
        const res = ingestAgentNote({
          subject: payload.subject,
          claim: payload.claim,
          evidence: payload.evidence,
          category: payload.category,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          upn: ctx.upn,
        })
        if (res.ok) return { ok: true, noteId: res.id }
        return { ok: false, reason: res.reason }
      }),
    ),
  ],
  // record_table_verdict — Plan v3 Phase 5. Persists a structured role
  // classification (canonical / subset / staging / archive / rules /
  // unknown) for an MSSQL object so future runs' search_catalog applies
  // the matching memoryVerdictBonus (Phase 4). Called by the reflection
  // turn the orchestrator injects after data-shaped goals complete.
  (ctx) => [
    ctx.govern(
      bindRecordTableVerdictTool(async (payload) => {
        try {
          const v = recordTableVerdict({
            qname: payload.qname,
            role: payload.role,
            evidence: payload.evidence,
            observedFromGoal: payload.observedFromGoal,
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            upn: ctx.upn,
          })
          return { ok: true, verdictId: v.id }
        } catch (err) {
          return { ok: false, reason: (err as Error).message }
        }
      }),
    ),
  ],
]

/**
 * Compose the final tool list for a run. `governedStaticTools` are the
 * registry tools after effect-wrapping and governance; this function
 * appends the output of every per-run factory in order.
 */
export function composePerRunTools(governedStaticTools: Tool[], ctx: PerRunToolContext): Tool[] {
  return [...governedStaticTools, ...PER_RUN_FACTORIES.flatMap((f) => f(ctx))]
}

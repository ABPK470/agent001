/**
 * Tool registry — single source of truth for all available agent tools.
 *
 * Agents pick a subset by name. The factory list ({@link ALL_TOOL_FACTORIES})
 * is the only authority for what the registry advertises; every accessor
 * (`getAllTools`, `resolveTools`, `getToolMap`, `listAvailableTools`) flows
 * through it. Tools are built host-bound: each factory takes an
 * {@link AgentHost} and returns a {@link Tool} closed over that host.
 * No ambient/global host lookup happens here — callers must supply a host.
 */

import {
  appendFileToolMetadata,
  ASK_USER_DESCRIPTION,
  ASK_USER_PARAMETERS,
  askUserToolMetadata,
  bindNoteTool,
  bindRecallPriorResultTool,
  bindRecordTableVerdictTool,
  browserAutoLoginTool,
  browserCheckTool,
  browserHumanHandoffTool,
  browseWebTool,
  createAppendFileTool,
  createAskUserTool,
  createBrowserAutoLoginTool,
  createBrowserCheckTool,
  createBrowserHumanHandoffTool,
  createBrowseWebTool,
  createDelegateTools,
  createDiscoverRelationshipsTool,
  createExportQueryToFileTool,
  createFetchUrlTool,
  createImportAttachmentTool,
  createInspectDefinitionTool,
  createListAttachmentsTool,
  createListDirectoryTool,
  createMssqlSchemaTool,
  createMssqlTool,
  createProfileDataTool,
  createPromoteAttachmentTool,
  createReadAttachmentTool,
  createReadFileTool,
  createReplaceInFileTool,
  createSearchCatalogTool,
  createSearchFilesTool,
  createShellTool,
  createWebSearchTool,
  createWriteFileTool,
  discoverRelationshipsTool,
  exportQueryToFileTool,
  fetchUrlTool,
  getChartSpecsTool,
  getChartSpecsToolMetadata,
  importAttachmentToolMetadata,
  inspectDefinitionTool,
  listAttachmentsToolMetadata,
  listDirectoryToolMetadata,
  mssqlSchemaTool,
  mssqlTool,
  noteToolMetadata,
  profileDataTool,
  promoteAttachmentToolMetadata,
  readAttachmentToolMetadata,
  readFileToolMetadata,
  recallPriorResultToolMetadata,
  recordTableVerdictToolMetadata,
  replaceInFileToolMetadata,
  searchCatalogTool,
  searchFilesToolMetadata,
  shellTool,
  thinkTool,
  webSearchTool,
  writeFileToolMetadata,
  type AgentHost,
  type DelegateContext,
  type ExecutableTool,
  type GovernToolOptions,
  type RunContext,
  type ToolMetadata,
} from "@mia/agent"
import {
  compareCatalogsTool,
  createCompareCatalogsTool,
  createListEnvironmentsTool,
  createSyncExecuteTool,
  createSyncPreviewTool,
  listEnvironmentsTool,
  syncExecuteTool,
  syncPreviewTool,
} from "@mia/sync"
import { ingestAgentNote, recordTableVerdict } from "./adapters/persistence/memory.js"
import { getToolResult, isRecallableToolResult, loadRecentToolResults } from "./adapters/persistence/tool-results.js"
import { AgentBus, createBusTools } from "./agent-bus.js"

export { thinkTool }

export interface ToolInfo extends Pick<ToolMetadata, "name" | "description"> {}

type StaticToolBinder = {
  metadata: ToolMetadata
  bind: (host: AgentHost, run?: RunContext) => ExecutableTool
}

const STATIC_TOOL_BINDERS: readonly StaticToolBinder[] = [
  // ── Filesystem (host-bound) ──
  { metadata: readFileToolMetadata, bind: (host) => createReadFileTool(host) },
  { metadata: writeFileToolMetadata, bind: (host) => createWriteFileTool(host) },
  { metadata: appendFileToolMetadata, bind: (host) => createAppendFileTool(host) },
  { metadata: replaceInFileToolMetadata, bind: (host) => createReplaceInFileTool(host) },
  { metadata: listDirectoryToolMetadata, bind: (host) => createListDirectoryTool(host) },
  { metadata: searchFilesToolMetadata, bind: (host) => createSearchFilesTool(host) },
  // ── Shell + browser (host-bound) ──
  { metadata: shellTool, bind: (host, run) => createShellTool(host, run) },
  { metadata: browseWebTool, bind: (host, run) => createBrowseWebTool(host, run) },
  { metadata: browserCheckTool, bind: (host) => createBrowserCheckTool(host) },
  { metadata: browserAutoLoginTool, bind: (host) => createBrowserAutoLoginTool(host) },
  { metadata: browserHumanHandoffTool, bind: (host) => createBrowserHumanHandoffTool(host) },
  { metadata: webSearchTool, bind: (host) => createWebSearchTool(host) },
  // ── Legacy runtime-backed factories (host arg ignored) ──
  { metadata: fetchUrlTool, bind: (_host, run) => createFetchUrlTool(run) },
  // ── User input (host-bound) ──
  { metadata: askUserToolMetadata, bind: (host) => createAskUserTool(host) },
  // ── Misc ambient ──
  { metadata: getChartSpecsToolMetadata, bind: () => getChartSpecsTool },
  { metadata: thinkTool, bind: () => thinkTool },
  // ── MSSQL (host-bound) / catalog (ambient) ──
  { metadata: mssqlTool, bind: (host, run) => createMssqlTool(host, run) },
  { metadata: mssqlSchemaTool, bind: (host, run) => createMssqlSchemaTool(host, run) },
  { metadata: exportQueryToFileTool, bind: (host, run) => createExportQueryToFileTool(host, run) },
  { metadata: discoverRelationshipsTool, bind: (host) => createDiscoverRelationshipsTool(host) },
  { metadata: profileDataTool, bind: (host, run) => createProfileDataTool(host, run) },
  { metadata: inspectDefinitionTool, bind: (host) => createInspectDefinitionTool(host) },
  { metadata: searchCatalogTool, bind: (host) => createSearchCatalogTool(host) },
  // ── ABI environment sync ──
  { metadata: compareCatalogsTool, bind: (host) => createCompareCatalogsTool(host) },
  { metadata: syncPreviewTool, bind: (host) => createSyncPreviewTool(host) },
  { metadata: syncExecuteTool, bind: (host) => createSyncExecuteTool(host) },
  { metadata: listEnvironmentsTool, bind: (host) => createListEnvironmentsTool(host) },
  // ── Attachments (host-bound) ──
  { metadata: listAttachmentsToolMetadata, bind: (host) => createListAttachmentsTool(host) },
  { metadata: readAttachmentToolMetadata, bind: (host) => createReadAttachmentTool(host) },
  { metadata: importAttachmentToolMetadata, bind: (host) => createImportAttachmentTool(host) },
  { metadata: promoteAttachmentToolMetadata, bind: (host) => createPromoteAttachmentTool(host) },
]

const CATALOG_ONLY_TOOLS: readonly ToolMetadata[] = [
  noteToolMetadata,
  recallPriorResultToolMetadata,
  recordTableVerdictToolMetadata,
]

const DELEGATE_TOOL_CATALOG: readonly ToolMetadata[] = [
  {
    name: "delegate",
    description:
      "Delegate a focused sub-task to a child agent with its own iteration loop and tool set. " +
      "Use when work is separable and easier to verify as an independent unit.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Clear, specific goal for the child agent." },
        agentId: { type: "string", description: "Optional ID of a named agent definition to use." },
        instructions: { type: "string", description: "Optional system-level instructions for the child." },
        tools: { type: "array", items: { type: "string" }, description: "Optional subset of tool names." },
        maxIterations: { type: "number", description: "Optional iteration cap for the child agent." },
      },
      required: ["goal"],
    },
  },
  {
    name: "delegate_parallel",
    description:
      "Delegate multiple independent sub-tasks to child agents that run in parallel, then collect every result together.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Array of child-agent tasks to run in parallel.",
          items: {
            type: "object",
            properties: {
              goal: { type: "string", description: "Specific goal for this child agent." },
              agentId: { type: "string", description: "Optional agent definition ID." },
              instructions: { type: "string", description: "Optional child instructions." },
              tools: { type: "array", items: { type: "string" }, description: "Optional tool subset." },
              maxIterations: { type: "number", description: "Optional iteration cap." },
            },
            required: ["goal"],
          },
        },
      },
      required: ["tasks"],
    },
  },
]

const BUS_TOOL_CATALOG: readonly ToolMetadata[] = [
  {
    name: "send_message",
    description: "Send a coordination message to other agents in the current run tree.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic/channel for the message." },
        content: { type: "string", description: "Message content." },
        protocol: {
          type: "string",
          enum: ["status", "result", "help", "question", "answer", "broadcast"],
          description: "Coordination intent for the message.",
        },
        reply_to: { type: "string", description: "Required when protocol='answer'." },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "check_messages",
    description: "Read new inter-agent messages received since the last check.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Optional topic filter." },
        protocol: {
          type: "string",
          enum: ["status", "result", "help", "question", "answer", "broadcast"],
          description: "Optional protocol filter.",
        },
      },
      required: [],
    },
  },
  {
    name: "wait_for_response",
    description: "Block until another agent answers a previously sent question message.",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "ID of the question message to wait on." },
        timeout_ms: { type: "number", description: "Optional timeout in milliseconds." },
      },
      required: ["message_id"],
    },
  },
]

/**
 * Build all registered tools, each closed over the supplied host.
 * Callers must pass the host they want the tools to be bound to — e.g.
 * the per-run host built from boot deps + run workspace root.
 */
export function getAllTools(host: AgentHost, run?: RunContext): ExecutableTool[] {
  return STATIC_TOOL_BINDERS.map((entry) => entry.bind(host, run))
}

/** Build the name-keyed tool map for a given host. */
export function getToolMap(host: AgentHost, run?: RunContext): ReadonlyMap<string, ExecutableTool> {
  return new Map(getAllTools(host, run).map((t) => [t.name, t]))
}

/**
 * Build the catalog list used by `listAvailableTools()` and the agents
 * route — every static tool plus the delegate/bus families.
 */
function listRuntimeCatalogTools(): ToolMetadata[] {
  const catalog = new Map<string, ToolMetadata>()

  for (const tool of STATIC_TOOL_BINDERS.map((entry) => entry.metadata)) catalog.set(tool.name, tool)
  for (const tool of CATALOG_ONLY_TOOLS) catalog.set(tool.name, tool)
  for (const tool of DELEGATE_TOOL_CATALOG) catalog.set(tool.name, tool)
  for (const tool of BUS_TOOL_CATALOG) catalog.set(tool.name, tool)

  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name))
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

/**
 * Resolve an array of tool names into host-bound Tool objects. Throws on
 * unknown names.
 */
export function resolveTools(names: string[], host: AgentHost, run?: RunContext): ExecutableTool[] {
  const map = getToolMap(host, run)
  const resolved = names.map((name) => {
    const tool = map.get(name)
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
export function filterToolsForVisitor(tools: ExecutableTool[]): ExecutableTool[] {
  return tools.filter((t) => VISITOR_TOOL_NAMES.has(t.name))
}

/** Returns true if the named tool is in the visitor allowlist. */
export function isVisitorTool(name: string): boolean {
  return VISITOR_TOOL_NAMES.has(name)
}

// ── Per-run tool registry ────────────────────────────────────────
// Static tools (above) are stateless. A second class of tools must be
// constructed fresh per run because they close over run-scoped state:
// delegation (parent run-id, depth, child usage tracking), inter-agent
// bus (run-id + agent name), and ask_user (the pending-input resolver
// tied to this run's controller). Each per-run category is declared
// here as a factory and assembled by `composePerRunTools`.

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
  govern: (tool: ExecutableTool, opts?: Pick<GovernToolOptions, "timeoutMs">) => ExecutableTool
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

export type PerRunToolFactory = (ctx: PerRunToolContext) => ExecutableTool[]

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
        name: "ask_user",
        description: ASK_USER_DESCRIPTION,
        parameters: ASK_USER_PARAMETERS,
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
  // recall_prior_result — no-amnesia Phase 9. Fetches the full payload of a
  // tool call from an earlier turn in the same session. Backed by the
  // tool_results table. Read-only, no governance needed beyond defaults.
  (ctx) => [
    ctx.govern(
      bindRecallPriorResultTool(async (payload) => {
        try {
          // Path 1: explicit evidence-tag lookup.
          if (payload.runId && payload.toolCallId) {
            const row = getToolResult(payload.runId, payload.toolCallId)
            if (!row) return { ok: false, reason: `no tool result for run=${payload.runId} tool_call=${payload.toolCallId}` }
            if (!isRecallableToolResult(row)) {
              return { ok: false, reason: `tool result for run=${payload.runId} tool_call=${payload.toolCallId} is not recallable in this context` }
            }
            return formatRecall(row, payload.full === true)
          }
          // Path 2: turn-relative lookup. Requires a session.
          if (!ctx.sessionId) {
            return { ok: false, reason: "no session bound to this run; pass runId + toolCallId from <prior_results> instead" }
          }
          const limit = Math.abs(payload.turn ?? -1)
          const toolNames = payload.toolName ? [payload.toolName] : undefined
          const rows = loadRecentToolResults({
            sessionId: ctx.sessionId,
            limit: Math.max(limit, 25),
            ...(toolNames ? { toolNames } : {}),
          })
          // loadRecentToolResults returns newest-first; turn=-1 → rows[0], -2 → rows[1].
          // Exclude the current run so the model never recalls its own in-flight call.
          const filtered = rows.filter((r) => r.run_id !== ctx.runId && isRecallableToolResult(r))
          const target = filtered[limit - 1]
          if (!target) {
            return { ok: false, reason: `no prior result at turn=${payload.turn ?? -1}${payload.toolName ? ` for tool ${payload.toolName}` : ""}` }
          }
          return formatRecall(target, payload.full === true)
        } catch (err) {
          return { ok: false, reason: (err as Error).message }
        }
      }),
    ),
  ],
]

/** Maximum chars returned when `full=false`. Still much larger than the
 *  per-result clip in <prior_results> (which is ~1500 chars). */
const RECALL_DEFAULT_CAP = 8 * 1024
/** Hard ceiling even when `full=true` — keeps a single tool result from
 *  blowing the per-call token budget. */
const RECALL_FULL_CAP = 48 * 1024

function formatRecall(
  row: import("./adapters/persistence/tool-results.js").DbToolResult,
  full: boolean,
): { ok: true; result: string; toolName: string; runId: string; toolCallId: string; rowCount: number | null; truncated: boolean } {
  const text = extractStoredText(row.result_json)
  const cap = full ? RECALL_FULL_CAP : RECALL_DEFAULT_CAP
  const clipped = text.length > cap ? text.slice(0, cap) + "\n\n…[recall_prior_result clipped; re-run the original tool for the full payload]…" : text
  return {
    ok: true,
    result: clipped,
    toolName: row.tool_name,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    rowCount: row.row_count,
    truncated: row.truncated === 1 || text.length > cap,
  }
}

function extractStoredText(json: string): string {
  try {
    const parsed = JSON.parse(json) as { text?: unknown }
    if (typeof parsed.text === "string") return parsed.text
  } catch { /* fall through */ }
  return json
}

/**
 * Compose the final tool list for a run. `governedStaticTools` are the
 * registry tools after effect-wrapping and governance; this function
 * appends the output of every per-run factory in order.
 */
export function composePerRunTools(governedStaticTools: ExecutableTool[], ctx: PerRunToolContext): ExecutableTool[] {
  return [...governedStaticTools, ...PER_RUN_FACTORIES.flatMap((f) => f(ctx))]
}

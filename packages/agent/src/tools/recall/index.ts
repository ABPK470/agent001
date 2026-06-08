/**
 * recall_prior_result tool — on-demand fetch of a stored tool-call payload
 * from an earlier turn in the same session.
 *
 * Why this exists (no-amnesia, Phase 9):
 * The `<prior_results>` system anchor surfaces a clipped sample of recent
 * tool payloads. When the model needs the FULL payload (more rows, longer
 * text) it calls this tool with the evidence tag it saw in `<prior_results>`.
 *
 * The tool SHAPE is defined here in the agent package; the actual lookup
 * (DB query into `tool_results`) is injected by the server's per-run
 * factory because it needs session scope. Same pattern as `note` and
 * `record_table_verdict`.
 */

import type { ExecutableTool, ToolDefinition, ToolMetadata } from "../../domain/agent-types.js"

/** Payload passed to the bound handler. */
export interface RecallPriorResultPayload {
  /** Specific evidence tag if known: { runId, toolCallId } */
  runId?: string
  toolCallId?: string
  /** Or — pull the N-th most recent matching result in the session.
   *  -1 = latest, -2 = previous, etc. Defaults to -1 when no runId given. */
  turn?: number
  /** Optional tool-name filter (e.g. "query_mssql") when using turn-relative lookup. */
  toolName?: string
  /** When true, return the entire payload (no truncation). Default false. */
  full?: boolean
}

/** Handler signature injected by the server factory. */
export type RecallPriorResultHandler = (payload: RecallPriorResultPayload) => Promise<
  | {
      ok: true
      result: string
      toolName: string
      runId: string
      toolCallId: string
      rowCount: number | null
      truncated: boolean
    }
  | { ok: false; reason: string }
>

export const recallPriorResultToolMetadata: ToolMetadata = {
  name: "recall_prior_result",
  description:
    "Retrieve the FULL payload of a tool call from an earlier turn in THIS session. " +
    "Use this BEFORE quoting numbers, building a chart, or claiming any specific data " +
    "value that you saw 'last time' — never paraphrase from <prior_turns> prose. " +
    "Look at the <prior_results> block: each entry has an evidence tag like " +
    "[evidence: run=<id>, tool_call=<id>]. Pass that runId + toolCallId to get the " +
    "exact payload. If you don't have a tag handy, omit them and use turn=-1 (latest) " +
    "or turn=-2 (previous) with an optional toolName filter. " +
    "Returns 'not found' if the result has been pruned or the session has none.",
  parameters: {
    type: "object",
    properties: {
      runId: {
        type: "string",
        description: "Run id from a <prior_results> evidence tag. Pair with toolCallId."
      },
      toolCallId: {
        type: "string",
        description: "Tool-call id from a <prior_results> evidence tag. Pair with runId."
      },
      turn: {
        type: "integer",
        description:
          "Relative turn index when you don't have an evidence tag: " +
          "-1 = most recent prior result, -2 = the one before, etc. " +
          "Default: -1 if runId/toolCallId are both omitted."
      },
      toolName: {
        type: "string",
        description: "Optional filter for turn-relative lookup. Example: 'query_mssql'."
      },
      full: {
        type: "boolean",
        description:
          "When true, return the entire stored payload. Default false — the handler " +
          "still returns more than <prior_results> clipped, but caps very large payloads."
      }
    }
  }
}

export const recallPriorResultTool = recallPriorResultToolMetadata

export const recallPriorResultToolDefinition: ToolDefinition<RecallPriorResultHandler> = {
  metadata: recallPriorResultToolMetadata,
  bind(handler) {
    return {
      ...recallPriorResultToolMetadata,
      async execute(args) {
        const runIdRaw = args["runId"]
        const toolCallIdRaw = args["toolCallId"]
        const turnRaw = args["turn"]
        const toolNameRaw = args["toolName"]
        const fullRaw = args["full"]

        const runId = typeof runIdRaw === "string" && runIdRaw.trim() ? runIdRaw.trim() : undefined
        const toolCallId =
          typeof toolCallIdRaw === "string" && toolCallIdRaw.trim() ? toolCallIdRaw.trim() : undefined
        const toolName =
          typeof toolNameRaw === "string" && toolNameRaw.trim() ? toolNameRaw.trim() : undefined
        const full = fullRaw === true
        let turn: number | undefined =
          typeof turnRaw === "number" && Number.isFinite(turnRaw) ? Math.trunc(turnRaw) : undefined

        if ((runId && !toolCallId) || (!runId && toolCallId)) {
          return (
            "Error: runId and toolCallId must be provided together (they come as a pair " +
            "from a <prior_results> evidence tag)."
          )
        }

        if (!runId && !toolCallId && turn === undefined) turn = -1

        if (turn !== undefined && turn >= 0) {
          return "Error: 'turn' must be a negative integer (-1 = latest prior result, -2 = previous, ...)."
        }

        const payload: RecallPriorResultPayload = {}
        if (runId) payload.runId = runId
        if (toolCallId) payload.toolCallId = toolCallId
        if (turn !== undefined) payload.turn = turn
        if (toolName) payload.toolName = toolName
        if (full) payload.full = true

        const result = await handler(payload)
        if (!result.ok) return `recall_prior_result: not found — ${result.reason}`

        const header =
          `recall_prior_result: tool=${result.toolName} run=${result.runId} tool_call=${result.toolCallId}` +
          (result.rowCount != null ? ` rows=${result.rowCount}` : "") +
          (result.truncated ? " [truncated]" : "")
        return `${header}\n\n${result.result}`
      }
    }
  }
}

/**
 * Build a per-run-bound copy of the recall tool. Server's PER_RUN_FACTORIES
 * uses this to attach the session-scoped lookup over `tool_results`.
 */
export function bindRecallPriorResultTool(handler: RecallPriorResultHandler): ExecutableTool {
  return recallPriorResultToolDefinition.bind(handler)
}

// ── Host-bound factory (Phase 4 item 7 — API surface only) ───────

import type { AgentHost } from "../../application/shell/runtime.js"

export function createRecallPriorResultTool(_host: AgentHost): never {
  throw new Error(
    "recall_prior_result requires per-run binding via bindRecallPriorResultTool(handler); metadata is available via recallPriorResultToolMetadata"
  )
}

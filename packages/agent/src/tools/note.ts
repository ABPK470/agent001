/**
 * note tool — durable, mid-conversation memory write for the agent.
 *
 * The agent already reads memory (working / episodic / semantic tiers are
 * injected into the system prompt by the orchestrator), but until this tool
 * existed it had no way to WRITE a structured fact into memory. End-of-run
 * episodic ingestion was the only durable write surface, which meant any
 * mid-conversation discovery (a confirmed join key, a column's semantics, a
 * data quality observation) lived only in the chat tape and was lost the
 * moment the working window pruned or context was compacted.
 *
 * This module defines the tool SHAPE and parameter contract. The actual
 * persistence is injected by the server's per-run factory because it needs
 * run-scoped state (sessionId / runId / upn) and access to the memory store.
 * See packages/server/src/tools.ts PER_RUN_FACTORIES for the wiring.
 *
 * Following the same hybrid pattern as ask_user: the base execute below
 * returns a clear error message if no handler is bound, so a misconfigured
 * agent never silently swallows note writes.
 */

import type { ExecutableTool, ToolDefinition, ToolMetadata } from "../domain/agent-types.js"

/** Allowed values for the optional `category` field. Free-form is intentionally
 * NOT allowed so consolidation and retrieval can rely on a small vocabulary. */
export const NOTE_CATEGORIES = [
  "schema_fact",
  "join_path",
  "column_semantics",
  "data_quality",
  "performance",
  "observation"
] as const

export type NoteCategory = (typeof NOTE_CATEGORIES)[number]

/** Structured payload passed to the bound handler. */
export interface NotePayload {
  subject: string
  claim: string
  evidence?: string
  category?: NoteCategory
}

/** Handler signature injected by the server-side factory. */
export type NoteHandler = (
  payload: NotePayload
) => Promise<{ ok: true; noteId: string } | { ok: false; reason: string }>

export const noteToolMetadata: ToolMetadata = {
  name: "note",
  description:
    "Save a durable, structured fact to working memory so future turns see it. " +
    "RARELY NEEDED — the validator auto-persists doctrine lessons when it blocks or " +
    "warns a query, and the post-execution heuristics (dim-join NULL, profile-first, " +
    "lineage coverage, universe mismatch) surface their own banners. Use this tool " +
    "ONLY for facts that the automatic machinery cannot infer — e.g. a column's " +
    "semantic meaning confirmed against an external spec, or a business rule learned " +
    "from the user in this conversation. Do NOT use it to restate what a tool result " +
    "already showed or what the validator already flagged. " +
    "Subject should be a stable identifier (qualified-name like '<schema>.<Table>.<Column>' " +
    "or 'join:<schema>.<Table>↔<schema>.<Table>'). Claim is the fact. Evidence is " +
    "optional supporting detail.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description:
          "Stable identifier for what the note is about. Prefer qualified " +
          "names (schema.table or schema.table.column) or join descriptors. " +
          "Used as the FTS lookup key so consistent naming improves recall."
      },
      claim: {
        type: "string",
        description:
          "The discovered fact in one sentence. Be concrete and falsifiable: " +
          "'cumulative MTD column; non-summable across periods' not 'something to watch out for'."
      },
      evidence: {
        type: "string",
        description:
          "Optional supporting detail. Examples: 'confirmed via profile_data: " +
          "min=0, max=1.2M, distinct=12 per client per year', " +
          "'discover_relationships between=[A,B] returned FK on pkClient'."
      },
      category: {
        type: "string",
        enum: [...NOTE_CATEGORIES],
        description:
          "Optional tag. Defaults to 'observation'. Use 'column_semantics' for " +
          "aggregation rules on a column, 'join_path' for table relationships, " +
          "'schema_fact' for general structural facts, 'data_quality' for NULL " +
          "rates / range issues, 'performance' for cost or plan observations."
      }
    },
    required: ["subject", "claim"]
  }
}

export const noteTool: ExecutableTool = {
  ...noteToolMetadata,
  async execute() {
    return "Error: note tool is not bound to a run handler."
  }
}

export const noteToolDefinition: ToolDefinition<NoteHandler> = {
  metadata: noteToolMetadata,
  bind(handler) {
    return {
      ...noteToolMetadata,
      async execute(args) {
        const subject = String(args["subject"] ?? "").trim()
        if (!subject) return "Error: 'subject' is required (non-empty string)."

        const claim = String(args["claim"] ?? "").trim()
        if (!claim) return "Error: 'claim' is required (non-empty string)."

        const evidenceRaw = args["evidence"]
        const evidence =
          typeof evidenceRaw === "string" && evidenceRaw.trim() ? evidenceRaw.trim() : undefined

        const categoryRaw = args["category"]
        let category: NoteCategory | undefined
        if (typeof categoryRaw === "string" && categoryRaw.trim()) {
          if (!(NOTE_CATEGORIES as readonly string[]).includes(categoryRaw)) {
            return `Error: 'category' must be one of: ${NOTE_CATEGORIES.join(", ")}.`
          }
          category = categoryRaw as NoteCategory
        }

        const result = await handler({ subject, claim, evidence, category })
        if (!result.ok) return `note: not stored — ${result.reason}`
        return `note: stored (id=${result.noteId}) — ${category ?? "observation"}: ${subject}`
      }
    }
  }
}

/**
 * Build a per-run-bound copy of the note tool. The server's PER_RUN_FACTORIES
 * uses this to attach a closure over the memory writer + run context.
 *
 * Keep this thin: the heavy lifting (salience floor, dedup, embedding) lives
 * in the server's ingestAgentNote helper. This wrapper just validates inputs
 * and produces a tool-result string.
 */
export function bindNoteTool(handler: NoteHandler): ExecutableTool {
  return noteToolDefinition.bind(handler)
}

// ── Host-bound factory (Phase 4 item 7 — API surface only) ───────

import type { AgentHost } from "../application/shell/runtime.js"

export function createNoteTool(_host: AgentHost): never {
  throw new Error(
    "note requires per-run binding via bindNoteTool(handler); metadata is available via noteToolMetadata"
  )
}

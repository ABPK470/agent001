/**
 * record_table_verdict tool — durable role classification for an MSSQL
 * object, written by the agent during a post-run reflection turn
 * (Plan v3 Phase 5).
 *
 * Distinct from `note` because:
 *   - the payload is structured (role enum, evidence array, qname)
 *   - reads at rank time go through `listTableVerdicts` (NOT the FTS
 *     retrieval path used for free-form notes)
 *   - magnitudes in `search_catalog`'s scorer are calibrated against
 *     this exact role enum
 *
 * The base `execute` is a guard that returns an error if no handler is
 * bound — mirrors the `note` and `ask_user` pattern. The server's
 * per-run factory injects the real handler that calls
 * `recordTableVerdict` from server memory.
 */

import type { TableVerdictRoleType } from "../ports/index.js"
import type { Tool } from "../domain/agent-types.js"

export const TABLE_VERDICT_ROLES = [
  "canonical",
  "subset",
  "staging",
  "archive",
  "rules",
  "unknown",
] as const

export type TableVerdictRole = TableVerdictRoleType

export interface TableVerdictPayload {
  qname: string
  role: TableVerdictRole
  evidence: string[]
  observedFromGoal?: string
}

export type RecordTableVerdictHandler = (
  payload: TableVerdictPayload,
) => Promise<{ ok: true; verdictId: string } | { ok: false; reason: string }>

export const recordTableVerdictTool: Tool = {
  name: "record_table_verdict",
  description:
    "Record a durable role classification for an MSSQL table/view so future " +
    "runs' search_catalog ranks it correctly. Call ONLY during the post-run " +
    "reflection turn when the prompt explicitly asks for it, and ONLY when " +
    "you have direct evidence from a tool result you saw this run. Roles: " +
    "'canonical' = the right table for the metric (wide UNION view, full " +
    "history, used by the BI layer); 'subset' = a narrower scoped view of " +
    "a canonical (one branch of a UNION, single-product/region); 'staging' = " +
    "load/ETL intermediate; 'archive' = historical snapshot not used for " +
    "live queries; 'rules' = mapping/rule table containing parameters, not " +
    "the measured fact itself; 'unknown' = informational only. " +
    "Evidence MUST cite concrete observations (row count, view definition " +
    "fragment, profile_data finding) — never hearsay.",
  parameters: {
    type: "object",
    properties: {
      qname: {
        type: "string",
        description:
          "Schema-qualified object name (e.g. 'publish.Revenue'). Must be " +
          "an object you actually used or rejected this run.",
      },
      role: {
        type: "string",
        enum: [...TABLE_VERDICT_ROLES],
        description:
          "Structural role of this object relative to its sibling cluster.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description:
          "Short bullet observations supporting the role (≤200 chars each). " +
          "Examples: 'view defines UNION of 59 source tables', " +
          "'rowCount=270M dwarfs sibling rowCount=12M', " +
          "'viewDefinition references publish.RevenueESGRules as one branch'.",
      },
      observedFromGoal: {
        type: "string",
        description:
          "Optional one-line summary of the goal that produced this " +
          "verdict, for retrieval provenance.",
      },
    },
    required: ["qname", "role"],
  },

  async execute() {
    return "Error: record_table_verdict handler is not bound in this execution context. " +
      "Ensure the agent is constructed via composePerRunTools (server) so the " +
      "verdict writer is injected."
  },
}

/**
 * Build a per-run-bound copy of the record_table_verdict tool. The
 * server's PER_RUN_FACTORIES uses this to attach a closure over
 * `recordTableVerdict` + run/session/upn provenance.
 */
export function bindRecordTableVerdictTool(handler: RecordTableVerdictHandler): Tool {
  return {
    ...recordTableVerdictTool,
    async execute(args) {
      const qname = String(args["qname"] ?? "").trim()
      if (!qname) return "Error: 'qname' is required (non-empty string)."
      if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(qname)) {
        return "Error: 'qname' must be a schema-qualified object name (e.g. 'publish.Revenue')."
      }

      const roleRaw = String(args["role"] ?? "").trim()
      if (!(TABLE_VERDICT_ROLES as readonly string[]).includes(roleRaw)) {
        return `Error: 'role' must be one of: ${TABLE_VERDICT_ROLES.join(", ")}.`
      }
      const role = roleRaw as TableVerdictRole

      const evidenceRaw = args["evidence"]
      let evidence: string[] = []
      if (Array.isArray(evidenceRaw)) {
        evidence = evidenceRaw
          .map((e) => String(e ?? "").trim())
          .filter(Boolean)
          .map((e) => e.length > 200 ? e.slice(0, 200) : e)
      }

      const observedRaw = args["observedFromGoal"]
      const observedFromGoal = typeof observedRaw === "string" && observedRaw.trim()
        ? observedRaw.trim()
        : undefined

      const result = await handler({ qname, role, evidence, observedFromGoal })
      if (!result.ok) return `record_table_verdict: not stored — ${result.reason}`
      return `record_table_verdict: stored (id=${result.verdictId}) — ${qname} → ${role}`
    },
  }
}

// ── Host-bound factory (Phase 4 item 7 — API surface only) ───────

import type { AgentHost } from "../application/shell/runtime.js"

export function createRecordTableVerdictTool(_host: AgentHost): Tool {
  return {
    name: recordTableVerdictTool.name,
    description: recordTableVerdictTool.description,
    parameters: recordTableVerdictTool.parameters,
    execute: (args) => recordTableVerdictTool.execute(args),
  }
}

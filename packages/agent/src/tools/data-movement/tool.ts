/**
 * tools/data-movement/tool.ts — the `move_data` agent tool.
 *
 * Streams rows from a source connector to a target connector through an
 * optional declarative transform. Thin wrapper over the opaque
 * `host.connectors.port.value` port (built by @mia/server from persisted
 * connectors); the agent never imports adapter drivers.
 */

import type { AgentHost } from "../../application/shell/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../domain/agent-types.js"
import type { MoveSummary, ReadSpec, Transform, WriteSpec } from "@mia/shared-types"

function buildMoveDataTool(host: AgentHost): ExecutableTool {
  return {
    name: "move_data",
    description:
      "Move (copy) rows from a source connector to a target connector through an optional declarative transform. " +
      "Streaming — handles arbitrarily large datasets without loading them all into memory. " +
      "Use list_adapters to see connectors and their capabilities. " +
      "source.spec / target.spec are kind-specific: SQL kinds (mssql, postgres, hive) use { kind: 'sql', sql | table+mode }; " +
      "httpApi uses { kind: 'httpApi', method, path, ... }; webhdfs uses { kind: 'webhdfs', path, format }; " +
      "denodo uses { kind: 'denodo', view, params }. " +
      "transform = { columns: [{ from, to, cast? }], derive: [{ to, template: '${field}' }] }. " +
      "Write modes: 'append' (batch insert) or 'replace' (truncate+insert in one transaction, rolls back on error). " +
      "Returns a summary: status (completed|partial|failed), rowsRead, rowsWritten, errors.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: {
          type: "object",
          description: "Source connector + read spec.",
          properties: {
            connectorId: { type: "string", description: "Connector id (see list_adapters)." },
            spec: {
              type: "object",
              description: "Kind-specific read spec (e.g. { kind: 'sql', sql: 'SELECT ...' }).",
              additionalProperties: true,
            },
          },
          required: ["connectorId", "spec"],
        },
        target: {
          type: "object",
          description: "Target connector + write spec.",
          properties: {
            connectorId: { type: "string", description: "Connector id (see list_adapters)." },
            spec: {
              type: "object",
              description:
                "Kind-specific write spec (e.g. { kind: 'sql', table: 't', mode: 'append'|'replace' }).",
              additionalProperties: true,
            },
            stopOnError: {
              type: "boolean",
              description: "Append-mode: stop at the first failing batch (default true).",
            },
          },
          required: ["connectorId", "spec"],
        },
        transform: {
          type: "object",
          description: "Optional declarative transform applied row-by-row.",
          additionalProperties: true,
        },
      },
      required: ["source", "target"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const port = host.connectors.port.value
      if (!port) {
        return "move_data: connector data-movement is not configured on this server (no connectors port wired)."
      }
      const source = args["source"] as { connectorId: string; spec: ReadSpec } | undefined
      const target = args["target"] as { connectorId: string; spec: WriteSpec; stopOnError?: boolean } | undefined
      if (!source?.connectorId || !source.spec) return "move_data: source.connectorId and source.spec are required."
      if (!target?.connectorId || !target.spec) return "move_data: target.connectorId and target.spec are required."
      const transform = (args["transform"] ?? undefined) as Transform | undefined
      try {
        const summary: MoveSummary = await port.moveData(
          { connectorId: source.connectorId, spec: source.spec },
          { connectorId: target.connectorId, spec: target.spec, stopOnError: target.stopOnError },
          transform ? { transform } : undefined,
        )
        return formatSummary(summary)
      } catch (e) {
        return `move_data failed: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}

function formatSummary(s: MoveSummary): string {
  const lines = [
    `move_data: ${s.status} — rowsRead=${s.rowsRead} rowsWritten=${s.rowsWritten}`,
  ]
  if (s.failedAtRow !== null) lines.push(`  stopped at row ${s.failedAtRow}`)
  if (s.errors.length > 0) {
    lines.push(`  errors (${s.errors.length}):`)
    for (const e of s.errors.slice(0, 10)) lines.push(`    row ${e.row}: ${e.message}`)
    if (s.errors.length > 10) lines.push(`    ... +${s.errors.length - 10} more`)
  }
  return lines.join("\n")
}

export const moveDataToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildMoveDataTool(stub)
  return { name: t.name, description: t.description, parameters: t.parameters }
})()

export function createMoveDataTool(host: AgentHost): ExecutableTool {
  return buildMoveDataTool(host)
}

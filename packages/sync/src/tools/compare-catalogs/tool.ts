/**
 * `compare_catalogs` agent tool.
 */

import { randomUUID } from "node:crypto"
import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import { DEFAULT_MYMI_SCHEMA_ALLOWLIST, detectCatalogDrift } from "../../runtime/catalog-drift.js"
import { SyncOperationType } from "../../domain/enums.js"
import type { SyncRuntimeHost } from "../../ports/index.js"

// ── compare_catalogs ─────────────────────────────────────────────

function buildCompareCatalogsTool(host: SyncRuntimeHost): Tool {
  return {
    name: "compare_catalogs",
    description:
      "Compare the schema (tables + columns) of two MSSQL connections (source vs target). " +
      "Use this BEFORE sync_preview to detect environment drift that would cause sync failures. " +
      "Restricted to schemas: core, coreArchive, gate, gateArchive, master. " +
      "Returns a list of tables missing on target, tables missing on source, and column differences.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source MSSQL connection name." },
        target: { type: "string", description: "Target MSSQL connection name." }
      },
      required: ["source", "target"]
    },
    async execute(args) {
      const source = String(args.source).trim()
      const target = String(args.target).trim()
      try {
        const ctx = {
          kind: SyncOperationType.Preview,
          opId: randomUUID(),
          scope: "catalog" as const,
          source,
          target
        }
        const drift = await detectCatalogDrift(
          host,
          source,
          target,
          undefined,
          DEFAULT_MYMI_SCHEMA_ALLOWLIST,
          ctx
        )
        const issues = drift.issues
        const lines = [
          `Catalog comparison: ${source} → ${target}`,
          `  Compatible: ${drift.catalogCompatible ? "yes" : "no"}`,
          `  Issues found: ${issues.length}`,
          ...issues.slice(0, 200).map((i) => `    • ${i}`),
          ...(issues.length > 200 ? [`    … and ${issues.length - 200} more`] : [])
        ]
        return lines.join("\n")
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const compareCatalogsToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildCompareCatalogsTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const compareCatalogsTool = compareCatalogsToolMetadata

export function createCompareCatalogsTool(host: SyncRuntimeHost): ExecutableTool {
  return buildCompareCatalogsTool(host)
}


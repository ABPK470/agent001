/**
 * `sync_diff_scan` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import {
  listPublishedSyncDefinitionsForHost
} from "../../runtime/published-definitions.js"
import {
  formatSyncScopeResolution,
  resolveSyncScope
} from "../../core/scope/sync-scope-resolution.js"
import {
  formatSyncToolError,
  publishedEntityTypeHint,
  validatePublishedEntityType,
} from "../_shared/helpers.js"
import type { SyncEntityId } from "../../domain/definition-selection.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { syncDiffScan } from "../../runtime/sync-diff-scan.js"

// ── sync_diff_scan ───────────────────────────────────────────────

function buildSyncDiffScanTool(host: SyncRuntimeHost): Tool {
  return {
    name: "sync_diff_scan",
    description:
      "Run real hash-based sync previews across many ABI entity instances between a source and target environment. " +
      "Use when the user asks which instances are out of sync across envs without naming one id. " +
      "Each instance gets the same full SyncPlan as sync_preview (PK join + HASHBYTES diff). READ-ONLY. " +
      "Provide entityType (from list_sync_definitions / resolve_sync_scope) OR scope when entityType is unknown.",
    parameters: {
      type: "object",
      properties: {
        entityType: {
          type: "string",
          description: `Published sync definition id. From list_sync_definitions or resolve_sync_scope. Known ids: ${publishedEntityTypeHint(host)}.`
        },
        scope: {
          type: "string",
          description:
            "Natural-language scope when entityType is unknown — resolved against the published bundle (same as resolve_sync_scope)."
        },
        source: { type: "string", description: "Source MSSQL connection / environment name." },
        target: { type: "string", description: "Target MSSQL connection / environment name." },
        entityIds: {
          type: "array",
          items: { type: ["string", "number"] },
          description:
            "Optional explicit root ids to scan. When omitted, every instance on source is discovered and scanned."
        },
        maxEntities: {
          type: "number",
          description:
            "Optional sample limit when listing from source (default: scan every discovered instance). Use only for a quick probe after a timeout.",
        },
        tables: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional table filter for reporting only (e.g. [\"core.Pipeline\", \"core.Activity\"]). Full preview still runs for FK scope."
        },
        onlyDivergent: {
          type: "boolean",
          description: "Omit in-sync instances from results. Default true.",
          default: true
        },
        force: {
          type: "boolean",
          description: "Bypass the per-table 5M row safety cap. Default false.",
          default: false
        }
      },
      required: ["source", "target"]
    },
    async execute(args) {
      const source = String(args.source).trim()
      const target = String(args.target).trim()
      if (!source || !target) return "Error: source and target are required."

      let entityType = args.entityType ? String(args.entityType) : ""
      let tables = Array.isArray(args.tables) ? args.tables.map(String) : undefined

      if (!entityType) {
        const scope = String(args.scope ?? "").trim()
        if (!scope) {
          return "Error: provide entityType (preferred) or scope to resolve against published definitions."
        }
        const defs = listPublishedSyncDefinitionsForHost(host)
        const resolution = resolveSyncScope(scope, defs)
        if (resolution.matches.length === 0) {
          return `No published sync definition matched scope "${scope}".\n\n${formatSyncScopeResolution(resolution)}`
        }
        if (resolution.ambiguous || !resolution.top) {
          return `Scope "${scope}" is ambiguous.\n\n${formatSyncScopeResolution(resolution)}`
        }
        entityType = resolution.top.entityType
        if (!tables && resolution.top.tables?.length) tables = [...resolution.top.tables]
      }

      const entityError = validatePublishedEntityType(host, entityType)
      if (entityError) return entityError

      const rawIds = args.entityIds
      const entityIds = Array.isArray(rawIds)
        ? rawIds.map((id) => (typeof id === "number" ? id : String(id)))
        : undefined
      const maxEntities =
        args.maxEntities != null && args.maxEntities !== ""
          ? Math.max(Number(args.maxEntities), 1)
          : undefined
      const onlyDivergent = args.onlyDivergent !== false

      try {
        const scan = await syncDiffScan({
          host,
          entityType: entityType as SyncEntityId,
          source,
          target,
          entityIds,
          maxEntities,
          tables,
          onlyDivergent,
          force: Boolean(args.force),
          userUpn: host.sync.runs.actorUpn ?? undefined
        })

        const lines: string[] = [
          `Diff scan ${scan.entityType}: ${scan.source} → ${scan.target}`,
          scan.sampled
            ? `  On source: ${scan.totalOnSource} instance(s) · Scanned: ${scan.scanned} (sample) · Divergent: ${scan.divergent} · Errors: ${scan.errors.length}`
            : `  On source: ${scan.totalOnSource} instance(s) · Scanned: ${scan.scanned} · Divergent: ${scan.divergent} · Errors: ${scan.errors.length}`,
          ""
        ]

        if (scan.results.length === 0 && scan.errors.length === 0) {
          lines.push("No row differences detected for the scanned instances.")
          if (scan.sampled) {
            lines.push("")
            lines.push(
              "This was a sampled scan — omit maxEntities to scan every instance on source, or run sync_preview on a known id."
            )
          }
          return lines.join("\n")
        }

        if (scan.results.length > 0) {
          lines.push("Out of sync:")
          for (const r of scan.results.slice(0, 40)) {
            const label = r.displayName ? `${r.displayName} (id=${r.entityId})` : `id=${r.entityId}`
            const delta = r.totals.insert + r.totals.update + r.totals.delete
            lines.push(
              `  • ${label}: +${r.totals.insert} ~${r.totals.update} -${r.totals.delete} (Δ=${delta}) planId=${r.planId}${r.hasConflicts ? " ⛔conflicts" : ""}`
            )
            for (const t of r.tables.slice(0, 8)) {
              lines.push(`      ${t.table}: +${t.insert} ~${t.update} -${t.delete}`)
            }
            if (r.tables.length > 8) lines.push(`      … ${r.tables.length - 8} more table(s)`)
          }
          if (scan.results.length > 40) {
            lines.push(`  … and ${scan.results.length - 40} more divergent instance(s)`)
          }
          lines.push("")
        }

        if (scan.errors.length > 0) {
          lines.push(`Errors (${scan.errors.length}):`)
          for (const e of scan.errors.slice(0, 10)) {
            lines.push(`  • id=${e.entityId}: ${e.message}`)
          }
          if (scan.errors.length > 10) lines.push(`  … and ${scan.errors.length - 10} more`)
          lines.push("")
        }

        lines.push(
          "Next: run sync_preview on a specific entityId for the full per-table diff and dashboard block, or open the env-sync widget with the planId."
        )
        return lines.join("\n")
      } catch (e) {
        return formatSyncToolError(e)
      }
    }
  }
}

export const syncDiffScanToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildSyncDiffScanTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const syncDiffScanTool = syncDiffScanToolMetadata

export function createSyncDiffScanTool(host: SyncRuntimeHost): ExecutableTool {
  return buildSyncDiffScanTool(host)
}

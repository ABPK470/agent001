/**
 * `sync_preview` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import { movementOfTable, tableMovementTotal } from "@mia/shared-types"
import { previewSync } from "../../runtime/orchestrator/index.js"
import {
  formatSyncToolError,
  publishedEntityTypeHint,
  validatePublishedEntityType,
} from "../_shared/helpers.js"
import type { SyncEntityId } from "../../domain/definition-selection.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { formatSyncPreviewDashboardFence } from "../../runtime/preview-dashboard.js"

// ── sync_preview ─────────────────────────────────────────────────

function buildSyncPreviewTool(host: SyncRuntimeHost): Tool {
  return {
    name: "sync_preview",
    description:
      "Compute a SyncPlan for migrating one published ABI sync entity instance " +
      "from a source environment to a target environment. READ-ONLY — only computes the diff, does not modify data. " +
      "entityType comes from list_sync_definitions or resolve_sync_scope. Returns a planId for sync_execute. " +
      "Refuses with publish_required when the catalog tip is ahead of the published contract for this entity — tell the user to Publish from Entity Registry. " +
      "gave a name, call search_sync_entities first. Use compare_catalogs first if drift is suspected. " +
      "Always emit the returned summary inline in your chat answer using a `dashboard` fenced block; never write the " +
      "result to a file.",
    parameters: {
      type: "object",
      properties: {
        entityType: {
          type: "string",
          description: `Published sync definition id to sync. One of: ${publishedEntityTypeHint(host)}.`
        },
        entityId: {
          type: ["string", "number"],
          description: "Primary key of the entity (e.g. pkContract value)."
        },
        source: { type: "string", description: "Source MSSQL connection / environment name." },
        target: { type: "string", description: "Target MSSQL connection / environment name." },
        force: {
          type: "boolean",
          description: "Bypass the per-table 5M row safety cap. Default false.",
          default: false
        }
      },
      required: ["entityType", "entityId", "source", "target"]
    },
    async execute(args) {
      const entityType = String(args.entityType) as SyncEntityId
      const entityError = validatePublishedEntityType(host, entityType)
      if (entityError) return entityError
      try {
        const plan = await previewSync({
          host,
          entityType,
          entityId: args.entityId as string | number,
          source: String(args.source),
          target: String(args.target),
          force: Boolean(args.force),
          userUpn: host.sync.runs.actorUpn ?? undefined
        })
        // Compact summary; full plan available via /api/sync/plan/:planId
        const lines: string[] = []
        lines.push(`Plan ${plan.planId} — ${plan.entity.type} ${plan.entity.displayName ?? plan.entity.id}`)
        lines.push(`  ${plan.source} → ${plan.target}`)
        lines.push(
          `  Totals: +${plan.totals.insert} ~${plan.totals.update} -${plan.totals.delete} (=${plan.totals.unchanged} unchanged) across ${plan.totals.tablesCount} table(s)`
        )
        lines.push(`  Estimated duration: ~${plan.estimatedDurationSec}s`)
        if (plan.warnings.length) {
          lines.push(`  Warnings:`)
          for (const w of plan.warnings.slice(0, 5)) lines.push(`    • ${w}`)
          if (plan.warnings.length > 5) lines.push(`    … and ${plan.warnings.length - 5} more`)
        }
        lines.push(``)

        // ── Conflict details — include ALL rows so the LLM can show them ──
        const conflictedTables = plan.tables.filter((t) => t.conflicts.length > 0)
        if (conflictedTables.length > 0) {
          lines.push(`SCOPE CONFLICTS — execute is BLOCKED until resolved:`)
          for (const t of conflictedTables) {
            lines.push(`  Table: ${t.table} (${t.conflicts.length} conflict(s))`)
            for (const c of t.conflicts) {
              lines.push(
                `    • pk=${c.pk} | expected=${JSON.stringify(c.expectedScope)} | actual=${JSON.stringify(c.actualScope)} | ${c.summary}`
              )
            }
          }
          lines.push(``)
        }

        lines.push(`Per-table diff:`)
        for (const t of plan.tables) {
          const m = movementOfTable(t)
          if (tableMovementTotal(t) === 0) continue
          lines.push(
            `  ${t.table}: +${m.insert} ~${m.update} -${m.delete}${t.conflicts.length > 0 ? ` ⛔${t.conflicts.length} conflicts` : ""}${t.stats.lowConfidence > 0 ? ` (⚠ ${t.stats.lowConfidence} low-confidence)` : ""}`
          )
        }
        lines.push(``)
        lines.push(`Open the env-sync widget for the full visual diff.`)
        lines.push(``)
        lines.push(`Include this dashboard block verbatim in your answer:`)
        lines.push(formatSyncPreviewDashboardFence(plan))
        lines.push(``)
        lines.push(`Apply command:`)
        lines.push(`sync_execute planId="${plan.planId}" confirm=true`)
        return lines.join("\n")
      } catch (e) {
        return formatSyncToolError(e)
      }
    }
  }
}

export const syncPreviewToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildSyncPreviewTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const syncPreviewTool = syncPreviewToolMetadata

export function createSyncPreviewTool(host: SyncRuntimeHost): ExecutableTool {
  return buildSyncPreviewTool(host)
}

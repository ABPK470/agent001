 /**
 * Sync tools — agent-facing wrappers around the orchestrator.
 *
 *   compare_catalogs : drift detection between source/target environments
 *   sync_preview     : compute a SyncPlan for an entity, return planId + summary
 *   sync_execute     : execute a previously-computed plan with safety rails
 */

import { randomUUID } from "node:crypto"
import type { ExecutableTool, Tool, ToolMetadata } from "../ports/host.js"
import { movementOfTable, tableMovementTotal } from "@mia/shared-types"
import { parseEntityInstanceRef } from "../domain/entity-instance-ref.js"
import { DEFAULT_MYMI_SCHEMA_ALLOWLIST, detectCatalogDrift } from "../runtime/catalog-drift.js"
import { SyncOperationType } from "../domain/enums.js"
import { getEnvironments } from "../domain/environments.js"
import {
  isPublishedSyncEntityType,
  listPublishedSyncDefinitionIds,
  listPublishedSyncDefinitionsForHost
} from "../domain/published-definitions.js"
import { isSyncPublishRequiredError, PUBLISH_REQUIRED_CODE } from "../domain/publish-readiness.js"
import type { SyncEntityId } from "../domain/definition-selection.js"
import {
  formatSyncScopeResolution,
  resolveSyncScope
} from "../domain/sync-scope-resolution.js"
import type { SyncRuntimeHost } from "../ports/index.js"
import { executeSync, previewSync, resolveSyncEntitySearch, searchEntities } from "../runtime/orchestrator/index.js"
import { loadPlan } from "../runtime/plan-store.js"
import { formatSyncPreviewDashboardFence } from "../runtime/preview-dashboard.js"
import { syncDiffScan } from "../runtime/sync-diff-scan.js"

function publishedEntityTypeHint(host: SyncRuntimeHost): string {
  try {
    const ids = listPublishedSyncDefinitionIds(host)
    return ids.length > 0 ? ids.join(", ") : "a published sync definition id"
  } catch {
    return "a published sync definition id"
  }
}

function validatePublishedEntityType(host: SyncRuntimeHost, entityType: string): string | null {
  try {
    if (!isPublishedSyncEntityType(host, entityType)) {
      const known = listPublishedSyncDefinitionIds(host)
      return `Error: invalid entityType "${entityType}". Must be one of: ${known.join(", ") || "(none published)"}`
    }
    return null
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Agent-visible error string — includes publish_required code when gated. */
function formatSyncToolError(error: unknown): string {
  if (isSyncPublishRequiredError(error)) {
    return (
      `Error [${PUBLISH_REQUIRED_CODE}]: ${error.message} ` +
      `Do not retry preview/execute until the user Publishes from Entity Registry.`
    )
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`
}

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


// ── search_sync_entities ─────────────────────────────────────────

function buildSearchSyncEntitiesTool(host: SyncRuntimeHost): Tool {
  return {
    name: "search_sync_entities",
    description:
      "Search for ABI sync entity rows in a source environment (recipe root table). " +
      "Resolves by primary key when q is numeric or tableId=/id= form (e.g. '2545', 'table 2545', 'tableId=2545'). " +
      "Otherwise matches the display label column (e.g. core.Contract.name). " +
      "When the user already gave a numeric id, prefer sync_preview directly — only search to disambiguate names. " +
      "Do NOT use search_catalog for sync entity lookup — it returns unrelated warehouse tables.",
    parameters: {
      type: "object",
      properties: {
        entityType: {
          type: "string",
          description: `Published sync definition id. One of: ${publishedEntityTypeHint(host)}.`
        },
        source: {
          type: "string",
          description: "Source environment / MSSQL connection to search in (same as sync source)."
        },
        q: {
          type: "string",
          description:
            "Instance reference: numeric id, id key form (tableId=2545), or display-name fragment (ACSRawTest)."
        },
        mode: {
          type: "string",
          enum: ["auto", "name", "id"],
          description:
            "Lookup mode. Default auto: numeric / id-key q searches primary key; otherwise label column."
        },
        limit: {
          type: "number",
          description: "Max results (default 20, max 50).",
          default: 20
        }
      },
      required: ["entityType", "source", "q"]
    },
    async execute(args) {
      const entityType = String(args.entityType) as SyncEntityId
      const entityError = validatePublishedEntityType(host, entityType)
      if (entityError) return entityError
      const source = String(args.source).trim()
      const rawQ = String(args.q).trim()
      if (!rawQ) return "Error: q (search query) is required."
      const explicitMode = args.mode === "id" || args.mode === "name" ? args.mode : "auto"
      const { q, mode } = resolveSyncEntitySearch(rawQ, explicitMode)
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
      try {
        const hits = await searchEntities(host, entityType, source, q, limit, mode)
        if (hits.length === 0) {
          const parsed = parseEntityInstanceRef(rawQ)
          if (parsed.entityId && mode === "id") {
            return `No ${entityType} row with id=${parsed.entityId} in ${source}. Verify the id exists on the recipe root table.`
          }
          return `No ${entityType} entities matching "${rawQ}" in ${source} (${mode} lookup). Try a shorter fragment or verify the source environment.`
        }
        const lines = [`${hits.length} match(es) for ${entityType} "${q}" in ${source} (${mode}):`]
        for (const hit of hits) {
          lines.push(`  • id=${hit.id}${hit.name ? ` — ${hit.name}` : ""}`)
        }
        if (hits.length === 1) {
          lines.push("")
          lines.push(`Use entityId=${hits[0]!.id} in sync_preview.`)
        } else {
          lines.push("")
          lines.push("Multiple matches — pick the correct id or ask the user to disambiguate.")
        }
        return lines.join("\n")
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const searchSyncEntitiesToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildSearchSyncEntitiesTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const searchSyncEntitiesTool = searchSyncEntitiesToolMetadata

export function createSearchSyncEntitiesTool(host: SyncRuntimeHost): ExecutableTool {
  return buildSearchSyncEntitiesTool(host)
}

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

// ── sync_execute ──────────────────────────────────────

function buildSyncExecuteTool(host: SyncRuntimeHost): Tool {
  return {
    name: "sync_execute",
    description:
      "Apply a previously-computed sync plan (from sync_preview) to the target environment. " +
      "MUTATIVE — modifies target data inside a single transaction with rollback on any error. " +
      "Refuses to run if: confirm!=true, plan is missing/expired, plan is older than 1 hour, " +
      "catalog tip is ahead of published contract (publish_required), " +
      "target environment is read-only (hosted policy), PROD is locked, or governance preflight fails.",
    parameters: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Plan UUID returned by sync_preview." },
        confirm: { type: "boolean", description: "Must be true to actually execute." }
      },
      required: ["planId", "confirm"]
    },
    async execute(args) {
      const planId = String(args.planId)
      const confirm = Boolean(args.confirm)
      if (!confirm) return `Error: confirm must be true to execute.`
      const plan = loadPlan(host, planId)
      if (!plan) return `Error: plan ${planId} not found or expired.`
      try {
        const result = await executeSync(planId, { host, confirm: true, userUpn: "agent" })
        if (result.outcome === "refused") return `Error: ${result.error}`
        if (result.outcome === "completed" && result.success) return `Plan ${planId} executed successfully against ${plan.target}.`
        return `Execute failed: ${result.error}`
      } catch (e) {
        return formatSyncToolError(e)
      }
    }
  }
}

export const syncExecuteToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildSyncExecuteTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const syncExecuteTool = syncExecuteToolMetadata

export function createSyncExecuteTool(host: SyncRuntimeHost): ExecutableTool {
  return buildSyncExecuteTool(host)
}

// ── list_environments (helper) ───────────────────────────────────

function buildListEnvironmentsTool(host: SyncRuntimeHost): Tool {
  return {
    name: "list_environments",
    description: "List all configured ABI environments (source/target candidates for sync).",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const envs = getEnvironments(host)
      if (envs.length === 0) return "No environments configured."
      const lines = ["Configured ABI environments:"]
      for (const e of envs) {
        lines.push(`  • ${e.name} — ${e.displayName} (${e.role}, ring ${e.ringOrder})`)
      }
      return lines.join("\n")
    }
  }
}

export const listEnvironmentsToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildListEnvironmentsTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const listEnvironmentsTool = listEnvironmentsToolMetadata

export function createListEnvironmentsTool(host: SyncRuntimeHost): ExecutableTool {
  return buildListEnvironmentsTool(host)
}

// ── list_sync_definitions ────────────────────────────────────────

function buildListSyncDefinitionsTool(host: SyncRuntimeHost): Tool {
  return {
    name: "list_sync_definitions",
    description:
      "List published ABI sync definitions from the runtime bundle — ids, display names, root tables, and recipe tables. " +
      "Call this to discover what entity types exist before sync_preview or sync_diff_scan. Authority is the published bundle, not hardcoded names.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const defs = listPublishedSyncDefinitionsForHost(host)
        if (defs.length === 0) return "No published sync definitions loaded."
        const lines = [`Published sync definitions (${defs.length}):`]
        for (const def of defs.sort((a, b) => a.id.localeCompare(b.id))) {
          const tables = def.metadata.tables.map((t) => t.name)
          lines.push(`  • ${def.id} — "${def.displayName}"`)
          lines.push(`    root: ${def.rootTable} (${def.idColumn})`)
          if (tables.length > 0) {
            lines.push(`    tables: ${tables.join(", ")}`)
          }
        }
        lines.push("")
        lines.push("When the user describes scope in business language, call resolve_sync_scope next.")
        return lines.join("\n")
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const listSyncDefinitionsToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildListSyncDefinitionsTool(stub)
  return { name: t.name, description: t.description, parameters: t.parameters }
})()

export const listSyncDefinitionsTool = listSyncDefinitionsToolMetadata

export function createListSyncDefinitionsTool(host: SyncRuntimeHost): ExecutableTool {
  return buildListSyncDefinitionsTool(host)
}

// ── resolve_sync_scope ───────────────────────────────────────────

function buildResolveSyncScopeTool(host: SyncRuntimeHost): Tool {
  return {
    name: "resolve_sync_scope",
    description:
      "Map a natural-language scope query (e.g. business terms the user used) to published sync definition ids. " +
      "Uses definition ids, display names, and recipe table names from the bundle. Returns ranked matches and flags ambiguity. " +
      "Call before sync_diff_scan when entityType is unclear.",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Scope phrase from the user goal — what to compare (exclude environment names)."
        }
      },
      required: ["q"]
    },
    async execute(args) {
      const q = String(args.q ?? "").trim()
      if (!q) return "Error: q (scope query) is required."
      try {
        const defs = listPublishedSyncDefinitionsForHost(host)
        const resolution = resolveSyncScope(q, defs)
        return formatSyncScopeResolution(resolution)
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

export const resolveSyncScopeToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildResolveSyncScopeTool(stub)
  return { name: t.name, description: t.description, parameters: t.parameters }
})()

export const resolveSyncScopeTool = resolveSyncScopeToolMetadata

export function createResolveSyncScopeTool(host: SyncRuntimeHost): ExecutableTool {
  return buildResolveSyncScopeTool(host)
}

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

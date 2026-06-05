/**
 * Sync tools — agent-facing wrappers around the orchestrator.
 *
 *   compare_catalogs : drift detection between source/target environments
 *   sync_preview     : compute a SyncPlan for an entity, return planId + summary
 *   sync_execute     : execute a previously-computed plan with safety rails
 */

import type { ExecutableTool, Tool, ToolMetadata } from "@mia/agent"
import { getEnvironments } from "../../domain/environments.js"
import type { EntityType } from "../../domain/recipes.js"
import { getPool, type AgentHost } from "../../ports/index.js"
import { executeSync, previewSync } from "./orchestrator/index.js"
import { loadPlan } from "./plan-store.js"

const VALID_ENTITY_TYPES = new Set<EntityType>([
  "contract",
  "dataset",
  "rule",
  "pipelineActivity",
  "gateMetadata",
  "content",
])

function normalizeCatalogName(name: string): string {
  return name.trim().toLowerCase()
}

// ── compare_catalogs ─────────────────────────────────────────────

function buildCompareCatalogsTool(host: AgentHost): Tool { return {
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
      target: { type: "string", description: "Target MSSQL connection name." },
    },
    required: ["source", "target"],
  },
  async execute(args) {
    const source = String(args.source).trim()
    const target = String(args.target).trim()
    try {
      const [src, tgt] = await Promise.all([fetchSchema(host, source), fetchSchema(host, target)])
      const issues: string[] = []
      // Tables missing on target
      for (const t of src.tables) if (!tgt.tables.has(t)) issues.push(`Missing on target: ${t}`)
      for (const t of tgt.tables) if (!src.tables.has(t)) issues.push(`Extra on target (not in source): ${t}`)
      // Column differences for tables present in both
      for (const t of src.tables) {
        if (!tgt.tables.has(t)) continue
        const sc = src.cols.get(t) ?? new Map()
        const tc = tgt.cols.get(t) ?? new Map()
        for (const [c, ty] of sc) {
          const tt = tc.get(c)
          if (!tt) issues.push(`${t}.${c}: missing on target`)
          else if (tt !== ty) issues.push(`${t}.${c}: type mismatch (source=${ty}, target=${tt})`)
        }
        for (const c of tc.keys()) if (!sc.has(c)) issues.push(`${t}.${c}: extra on target (not in source)`)
      }
      const lines = [
        `Catalog comparison: ${source} → ${target}`,
        `  Source tables: ${src.tables.size}`,
        `  Target tables: ${tgt.tables.size}`,
        `  Issues found: ${issues.length}`,
        ...issues.slice(0, 200).map((i) => `    • ${i}`),
        ...(issues.length > 200 ? [`    … and ${issues.length - 200} more`] : []),
      ]
      return lines.join("\n")
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
} }

export const compareCatalogsToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildCompareCatalogsTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }
})()

export const compareCatalogsTool = compareCatalogsToolMetadata

export function createCompareCatalogsTool(host: AgentHost): ExecutableTool {
  return buildCompareCatalogsTool(host)
}

async function fetchSchema(host: AgentHost, connection: string): Promise<{ tables: Set<string>; cols: Map<string, Map<string, string>> }> {
  const { pool } = await getPool(host, connection)
  const r = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA IN ('core','coreArchive','gate','gateArchive','master')
  `)
  const tables = new Set<string>()
  const cols = new Map<string, Map<string, string>>()
  for (const row of r.recordset as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number | null }>) {
    const qn = normalizeCatalogName(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`)
    tables.add(qn)
    if (!cols.has(qn)) cols.set(qn, new Map())
    const type = row.CHARACTER_MAXIMUM_LENGTH ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH})` : row.DATA_TYPE
    cols.get(qn)!.set(normalizeCatalogName(row.COLUMN_NAME), type)
  }
  return { tables, cols }
}



// ── sync_preview ─────────────────────────────────────────────────

function buildSyncPreviewTool(host: AgentHost): Tool { return {
  name: "sync_preview",
  description:
    "Compute a SyncPlan for migrating one ABI entity (Contract / Dataset / Rule / Pipeline / Gate Metadata / Content) " +
    "from a source environment to a target environment. READ-ONLY — only computes the diff, does not modify data. " +
    "Returns a planId you can later pass to sync_execute. Use compare_catalogs first if drift is suspected. " +
    "Always emit the returned summary inline in your chat answer using a `dashboard` fenced block; never write the " +
    "result to a file.",
  parameters: {
    type: "object",
    properties: {
      entityType: {
        type: "string",
        description: `Entity to sync. One of: ${[...VALID_ENTITY_TYPES].join(", ")}.`,
      },
      entityId: { type: ["string", "number"], description: "Primary key of the entity (e.g. pkContract value)." },
      source: { type: "string", description: "Source MSSQL connection / environment name." },
      target: { type: "string", description: "Target MSSQL connection / environment name." },
      force: { type: "boolean", description: "Bypass the per-table 5M row safety cap. Default false.", default: false },
    },
    required: ["entityType", "entityId", "source", "target"],
  },
  async execute(args) {
    const entityType = String(args.entityType) as EntityType
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return `Error: invalid entityType "${entityType}". Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}`
    }
    try {
      const plan = await previewSync({
        host,
        entityType,
        entityId: args.entityId as string | number,
        source: String(args.source),
        target: String(args.target),
        force: Boolean(args.force),
      })
      // Compact summary; full plan available via /api/sync/plan/:planId
      const lines: string[] = []
      lines.push(`Plan ${plan.planId} — ${plan.entity.type} ${plan.entity.displayName ?? plan.entity.id}`)
      lines.push(`  ${plan.source} → ${plan.target}`)
      lines.push(`  Totals: +${plan.totals.insert} ~${plan.totals.update} -${plan.totals.delete} (=${plan.totals.unchanged} unchanged) across ${plan.totals.tablesCount} table(s)`)
      lines.push(`  Estimated duration: ~${plan.estimatedDurationSec}s`)
      if (plan.warnings.length) {
        lines.push(`  Warnings:`)
        for (const w of plan.warnings.slice(0, 5)) lines.push(`    • ${w}`)
        if (plan.warnings.length > 5) lines.push(`    … and ${plan.warnings.length - 5} more`)
      }
      lines.push(``)

      // ── Conflict details — include ALL rows so the LLM can show them ──
      const conflictedTables = plan.tables.filter((t) => t.counts.conflicts > 0)
      if (conflictedTables.length > 0) {
        lines.push(`SCOPE CONFLICTS — execute is BLOCKED until resolved:`)
        for (const t of conflictedTables) {
          lines.push(`  Table: ${t.table} (${t.conflicts.length} conflict(s))`)
          for (const c of t.conflicts) {
            lines.push(`    • pk=${c.pk} | expected=${JSON.stringify(c.expectedScope)} | actual=${JSON.stringify(c.actualScope)} | ${c.summary}`)
          }
        }
        lines.push(``)
      }

      lines.push(`Per-table diff:`)
      for (const t of plan.tables) {
        const c = t.counts
        if (c.insert + c.update + c.delete + c.conflicts === 0) continue
        lines.push(`  ${t.table}: +${c.insert} ~${c.update} -${c.delete}${c.conflicts > 0 ? ` ⛔${c.conflicts} conflicts` : ""}${c.lowConfidence > 0 ? ` (⚠ ${c.lowConfidence} low-confidence)` : ""}`)
      }
      lines.push(``)
      lines.push(`Open the env-sync widget for the full visual diff.`)
      lines.push(`Apply command:`)
      lines.push(`sync_execute planId="${plan.planId}" confirm=true`)
      return lines.join("\n")
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
} }

export const syncPreviewToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildSyncPreviewTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }
})()

export const syncPreviewTool = syncPreviewToolMetadata

export function createSyncPreviewTool(host: AgentHost): ExecutableTool {
  return buildSyncPreviewTool(host)
}

// ── sync_execute ──────────────────────────────────────

function buildSyncExecuteTool(host: AgentHost): Tool { return {
  name: "sync_execute",
  description:
    "Apply a previously-computed sync plan (from sync_preview) to the target environment. " +
    "MUTATIVE — modifies target data inside a single transaction with rollback on any error. " +
    "Refuses to run if: confirm!=true, plan is missing/expired, plan is older than 1 hour, " +
    "target environment is read-only, or current user is not in the target's allowlist. " +
    "Always re-validates against the source before applying — aborts if drift > 5%.",
  parameters: {
    type: "object",
    properties: {
      planId: { type: "string", description: "Plan UUID returned by sync_preview." },
      confirm: { type: "boolean", description: "Must be true to actually execute." },
    },
    required: ["planId", "confirm"],
  },
  async execute(args) {
    const planId = String(args.planId)
    const confirm = Boolean(args.confirm)
    if (!confirm) return `Error: confirm must be true to execute.`
    const plan = loadPlan(host, planId)
    if (!plan) return `Error: plan ${planId} not found or expired.`
    try {
      const result = await executeSync(planId, { host, confirm: true, userUpn: "agent" })
      if (result.success) return `Plan ${planId} executed successfully against ${plan.target}.`
      return `Execute failed: ${result.error}`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
} }

export const syncExecuteToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildSyncExecuteTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }
})()

export const syncExecuteTool = syncExecuteToolMetadata

export function createSyncExecuteTool(host: AgentHost): ExecutableTool {
  return buildSyncExecuteTool(host)
}

// ── list_environments (helper) ───────────────────────────────────

function buildListEnvironmentsTool(host: AgentHost): Tool { return {
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
  },
} }

export const listEnvironmentsToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildListEnvironmentsTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }
})()

export const listEnvironmentsTool = listEnvironmentsToolMetadata

export function createListEnvironmentsTool(host: AgentHost): ExecutableTool {
  return buildListEnvironmentsTool(host)
}

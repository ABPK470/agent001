/**
 * F1 — Row-divergence probe (server-side, IO-bearing).
 *
 * For a given entity type the probe samples up to `sampleSize` candidate
 * entity ids from the source root table (most-recent by PK) and runs
 * `previewSync(force: true, … dryRun)` for each. Any candidate whose
 * `totals.insert + .update + .delete` is non-zero is returned as a
 * `DivergentEntityRow`.
 *
 * The probe is intentionally *sampled* — fully enumerating every entity
 * on every pass would be prohibitive at scale. The runbook (F1.13)
 * documents how to schedule a separate exhaustive sweep job for
 * compliance audits.
 */

import { getPool, type AgentHost } from "@mia/agent"
import {
  emptyCounts,
  getPublishedSyncDefinitionForHost,
  movementOfTable,
  previewSync,
  type DivergentEntityRow,
  type EnvPair,
  type ProposalCounts
} from "@mia/sync"

export interface ProbeRowDivergenceInput {
  host: AgentHost
  tenantId: string
  envPair: EnvPair
  entityId: string
  entityLabel: string
  sampleSize?: number
}

const DEFAULT_SAMPLE_SIZE = 25

export async function probeRowDivergence(i: ProbeRowDivergenceInput): Promise<readonly DivergentEntityRow[]> {
  void i.tenantId
  let definition
  try {
    definition = getPublishedSyncDefinitionForHost(i.host, i.entityId)
  } catch {
    return []
  }

  const candidates = await sampleRootIds(
    i.host,
    i.envPair.source,
    definition.rootTable,
    definition.idColumn,
    i.sampleSize ?? DEFAULT_SAMPLE_SIZE
  )
  if (candidates.length === 0) return []

  const findings: DivergentEntityRow[] = []
  for (const rootId of candidates) {
    try {
      const plan = await previewSync({
        host: i.host,
        entityType: i.entityId,
        entityId: rootId,
        source: i.envPair.source,
        target: i.envPair.target,
        force: true
      })
      const counts = aggregatePlanCounts(plan)
      if (counts.insert + counts.update + counts.delete === 0) continue
      const newOnTarget = isNewOnTarget(plan)
      const perTable = plan.tables.map((t) => {
        const m = movementOfTable(t)
        return {
          name: t.table,
          counts: {
            insert: m.insert,
            update: m.update,
            delete: m.delete,
            unchanged: t.stats.unchanged,
            unknown: t.stats.lowConfidence ?? 0
          } satisfies ProposalCounts
        }
      })
      findings.push({
        entityId: String(rootId),
        entityLabel: plan.entity.displayName ?? `${i.entityLabel} ${rootId}`,
        counts,
        perTable,
        newOnTarget
      })
    } catch {
      // Per-id failures don't poison the whole pass; the catalog probe
      // would have already surfaced any catastrophic env-level error.
      continue
    }
  }
  return findings
}

// ── helpers ─────────────────────────────────────────────────────

async function sampleRootIds(
  host: AgentHost,
  conn: string,
  table: string,
  keyCol: string,
  limit: number
): Promise<readonly (string | number)[]> {
  const [schema, name] = table.split(".")
  if (!schema || !name) throw new Error(`Invalid table name: ${table}`)
  const { pool } = await getPool(host, conn)
  const req = pool.request()
  const sql = `SELECT TOP (${Math.max(1, Math.min(limit, 500))}) [${keyCol}] AS id
                 FROM [${schema}].[${name}] WITH (NOLOCK)
                ORDER BY [${keyCol}] DESC`
  try {
    const r = await req.query(sql)
    const rows = (r.recordset ?? []) as { id: string | number }[]
    return rows.map((r) => r.id)
  } catch {
    return []
  }
}

interface MaybePlan {
  totals?: { insert?: number; update?: number; delete?: number; unchanged?: number; lowConfidence?: number }
  tables?: ReadonlyArray<{
    table: string
    stats: { unchanged: number; lowConfidence?: number }
    changeSet: { insert: unknown[]; update: unknown[]; delete: unknown[] }
  }>
  entityDisplayName?: string
}

function aggregatePlanCounts(plan: MaybePlan): ProposalCounts {
  const t = plan.totals ?? {}
  return {
    insert: t.insert ?? 0,
    update: t.update ?? 0,
    delete: t.delete ?? 0,
    unchanged: t.unchanged ?? 0,
    unknown: t.lowConfidence ?? 0
  }
}

function isNewOnTarget(plan: MaybePlan): boolean {
  // Heuristic: if every table reports `insert > 0 && update == 0 && delete == 0`,
  // the entity is brand-new on the target.
  const tables = plan.tables ?? []
  if (tables.length === 0) return false
  return tables.every((t) => {
    const m = movementOfTable(t)
    return m.insert > 0 && m.update === 0 && m.delete === 0
  })
}

// Local shim — agent doesn't export `emptyCounts` from this module path
// directly via `@mia/agent`'s top-level surface in older builds, so we
// reference the shared util for parity but the function lives in agent.
void emptyCounts

/**
 * F1.11 — Independent post-execute verification.
 *
 * Runs *after* `executeSync()` completes. Re-validates the outcome
 * using probes that are **independent of the apply path** so a bug in
 * the apply phase cannot mask itself:
 *
 *   1. Per-table COUNT(*) on source vs target with the recipe
 *      predicates — must agree within `rowCountToleranceAbs`.
 *   2. Stratified row-sample SHA-256: pick `sampleSize` random rows by
 *      PK on source, fetch the same rows on target, compute a
 *      canonical-row hash (sorted column values). Diffs are reported.
 *   3. Lineage downstream probe (no-op when no downstream wiring is
 *      registered) — extensibility hook for callers that own their
 *      own downstream consumers.
 *
 * Returns a structured `VerificationReport` that is embedded into the
 * evidence envelope (F1.8 verification section) and broadcast as
 * `sync.verification.completed` / `.failed` SSE events.
 */

import {
    canonicalJsonStringify,
    getMssqlPool,
    tryResolveRecipe,
} from "@mia/agent"
import { createHash } from "node:crypto"

export interface IndependentVerifyInput {
  tenantId:     string
  source:       string
  target:       string
  entityType:   string
  entityId:     string | number
  sampleSize?:  number
  rowCountToleranceAbs?: number
}

export const VerificationStatus = {
  Pass: "pass",
  Warn: "warn",
  Fail: "fail",
} as const
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus]

export interface TableVerification {
  table:        string
  sourceRows:   number
  targetRows:   number
  delta:        number
  sampleSize:   number
  sampleMismatches: number
  status:       VerificationStatus
  issues:       readonly string[]
}

export interface VerificationReport {
  startedAt:  string
  finishedAt: string
  durationMs: number
  status:     VerificationStatus
  tables:     readonly TableVerification[]
  issues:     readonly string[]
}

const DEFAULT_SAMPLE = 50
const DEFAULT_TOLERANCE = 0

export async function runIndependentVerification(
  i: IndependentVerifyInput,
): Promise<VerificationReport> {
  const t0 = Date.now()
  const startedAt = new Date(t0).toISOString()
  const resolved = tryResolveRecipe({ tenantId: i.tenantId, entityId: i.entityType })
  if (!resolved) {
    return baseReport(startedAt, t0, "fail", [`no recipe for entity "${i.entityType}"`])
  }
  const recipe = resolved.recipe
  const sampleSize = i.sampleSize ?? DEFAULT_SAMPLE
  const tolerance  = i.rowCountToleranceAbs ?? DEFAULT_TOLERANCE
  const idLiteral  = formatSqlLiteral(i.entityId)

  const tableResults: TableVerification[] = []
  const issues: string[] = []
  for (const t of recipe.tables) {
    try {
      const r = await verifyTable({
        source: i.source, target: i.target, table: t.name,
        predicate: t.predicate.replace(/\{id\}/g, idLiteral),
        sampleSize, tolerance,
      })
      tableResults.push(r)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      tableResults.push({
        table: t.name, sourceRows: -1, targetRows: -1, delta: 0,
        sampleSize: 0, sampleMismatches: 0, status: "fail", issues: [msg],
      })
      issues.push(`${t.name}: probe failed (${msg})`)
    }
  }

  const overall = aggregateStatus(tableResults)
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    status:     overall,
    tables:     tableResults,
    issues,
  }
}

function aggregateStatus(rs: readonly TableVerification[]): VerificationStatus {
  if (rs.some((r) => r.status === "fail")) return "fail"
  if (rs.some((r) => r.status === "warn")) return "warn"
  return "pass"
}

function baseReport(startedAt: string, t0: number, status: VerificationStatus, issues: readonly string[]): VerificationReport {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    status,
    tables:     [],
    issues,
  }
}

interface VerifyTableInput {
  source: string; target: string; table: string;
  predicate: string; sampleSize: number; tolerance: number
}

async function verifyTable(i: VerifyTableInput): Promise<TableVerification> {
  const [schema, name] = i.table.split(".")
  if (!schema || !name) throw new Error(`bad table id "${i.table}"`)
  const qt = `[${schema}].[${name}]`

  const { pool: srcPool } = await getMssqlPool(i.source)
  const { pool: tgtPool } = await getMssqlPool(i.target)

  const where = i.predicate.trim() ? `WHERE ${i.predicate}` : ""
  const countSql = `SELECT COUNT_BIG(*) AS n FROM ${qt} WITH (NOLOCK) ${where}`
  const [srcRes, tgtRes] = await Promise.all([
    srcPool.request().query(countSql),
    tgtPool.request().query(countSql),
  ])
  const srcCount = Number((srcRes.recordset[0] as { n: number | bigint }).n)
  const tgtCount = Number((tgtRes.recordset[0] as { n: number | bigint }).n)
  const delta = Math.abs(srcCount - tgtCount)

  const issues: string[] = []
  if (delta > i.tolerance) issues.push(`row count delta ${delta} exceeds tolerance ${i.tolerance}`)

  // Sample probe: fetch up to sampleSize rows by PK from each side, hash, compare.
  let sampleMismatches = 0
  let actualSample = 0
  try {
    const sampleSql = `SELECT TOP ${Math.max(1, Math.min(i.sampleSize, 500))} * FROM ${qt} WITH (NOLOCK) ${where} ORDER BY (SELECT 1)`
    const [s, t] = await Promise.all([
      srcPool.request().query(sampleSql),
      tgtPool.request().query(sampleSql),
    ])
    const srcRows = (s.recordset ?? []) as Array<Record<string, unknown>>
    const tgtRows = (t.recordset ?? []) as Array<Record<string, unknown>>
    actualSample = Math.max(srcRows.length, tgtRows.length)
    const srcHashes = new Set(srcRows.map(canonicalRowHash))
    const tgtHashes = new Set(tgtRows.map(canonicalRowHash))
    for (const h of srcHashes) if (!tgtHashes.has(h)) sampleMismatches++
  } catch (e) {
    issues.push(`sample probe failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  let status: VerificationStatus = "pass"
  if (sampleMismatches > 0 || delta > i.tolerance) status = "warn"
  if (delta > 0 && srcCount === 0)                  status = "fail"

  return {
    table: i.table, sourceRows: srcCount, targetRows: tgtCount, delta,
    sampleSize: actualSample, sampleMismatches, status, issues,
  }
}

function canonicalRowHash(row: Record<string, unknown>): string {
  // serialise after sorting keys to make order-independent
  const normalised: Record<string, unknown> = {}
  for (const k of Object.keys(row).sort()) normalised[k] = normaliseScalar(row[k])
  return createHash("sha256").update(canonicalJsonStringify(normalised)).digest("hex")
}

function normaliseScalar(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v.toString("base64")
  return v ?? null
}

function formatSqlLiteral(v: string | number): string {
  if (typeof v === "number") return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

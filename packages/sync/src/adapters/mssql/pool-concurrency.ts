/**
 * Derive safe sync parallelism from per-connection pool budgets.
 *
 * Table diff peak ≈ 2 concurrent slots per env (pk-hash + sample phases).
 * Entity preview runs N tables in parallel — bulk scans must not multiply
 * previews on top of that without shrinking the table fan-out first.
 */

import type { MssqlAccessHost } from "../../ports/host.js"
import { poolGateLimit, readPoolMax } from "./pool-gate.js"

/** Peak in-flight pool slots one table diff may hold on a single connection. */
export const PEAK_POOL_SLOTS_PER_TABLE = 2

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function resolvePreviewTableConcurrency(
  host: MssqlAccessHost,
  source: string,
  target: string
): number {
  const override = parsePositiveInt(process.env["SYNC_PREVIEW_CONCURRENCY"])
  if (override) return override

  const limit = Math.min(
    Math.floor(poolGateLimit(host, source) / PEAK_POOL_SLOTS_PER_TABLE),
    Math.floor(poolGateLimit(host, target) / PEAK_POOL_SLOTS_PER_TABLE)
  )
  return Math.max(1, limit)
}

/**
 * How many full entity previews may run at once (e.g. sync_diff_scan).
 * Defaults to 1 on typical pool sizes — table parallelism already fills the budget.
 */
export function resolveEntityPreviewConcurrency(
  host: MssqlAccessHost,
  source: string,
  target: string
): number {
  const override = parsePositiveInt(process.env["SYNC_ENTITY_PREVIEW_CONCURRENCY"])
  if (override) return override

  const tableConcurrency = resolvePreviewTableConcurrency(host, source, target)
  const slotsPerPreview = tableConcurrency * PEAK_POOL_SLOTS_PER_TABLE
  const limit = Math.min(
    Math.floor(poolGateLimit(host, source) / slotsPerPreview),
    Math.floor(poolGateLimit(host, target) / slotsPerPreview)
  )
  return Math.max(1, limit)
}

export interface PoolConcurrencySummary {
  readonly source: string
  readonly target: string
  readonly sourcePoolMax: number
  readonly targetPoolMax: number
  readonly tableConcurrency: number
  readonly entityConcurrency: number
}

export function summarizePoolConcurrency(
  host: MssqlAccessHost,
  source: string,
  target: string
): PoolConcurrencySummary {
  return {
    source,
    target,
    sourcePoolMax: readPoolMax(host, source),
    targetPoolMax: readPoolMax(host, target),
    tableConcurrency: resolvePreviewTableConcurrency(host, source, target),
    entityConcurrency: resolveEntityPreviewConcurrency(host, source, target)
  }
}

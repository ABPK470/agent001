/**
 * Platform import gate — shared mechanics for every file/snapshot apply
 * that mutates platform config. Domain validators stay local; this module
 * only builds the uniform result shape and enforce apply guards.
 */

import {
  emptyPlatformImportImpact,
  type PlatformImportGateResult,
  type PlatformImportImpact,
} from "@mia/shared-types"

export function emptyImpact(): PlatformImportImpact {
  return emptyPlatformImportImpact()
}

export function gateResult(args: {
  ok: boolean
  dryRun: boolean
  applied: boolean
  errors?: string[]
  warnings?: string[]
  impact?: PlatformImportImpact
  counts?: Record<string, number>
  version?: { version: number }
}): PlatformImportGateResult {
  return {
    ok: args.ok,
    dryRun: args.dryRun,
    applied: args.applied,
    errors: args.errors ?? [],
    warnings: args.warnings ?? [],
    impact: args.impact ?? emptyImpact(),
    counts: args.counts ?? {},
    ...(args.version ? { version: args.version } : {}),
  }
}

/** Trimmed non-empty reason required for apply. */
export function requireReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null
  const trimmed = reason.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Fail-closed apply guard. Returns an error message when apply must not proceed.
 */
export function assertCanApply(args: {
  dryRun: boolean
  reason: unknown
  ok: boolean
}): string | null {
  if (args.dryRun) return null
  if (!requireReason(args.reason)) return "reason is required to apply this import"
  if (!args.ok) return "import validation failed; fix errors before applying"
  return null
}

/** Map section counts into a coarse impact list when per-id lists are unavailable. */
export function impactFromCounts(
  counts: Record<string, number>,
  mode: "updates" | "creates" = "updates",
): PlatformImportImpact {
  const impact = emptyImpact()
  const bucket = mode === "creates" ? impact.creates : impact.updates
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== "number" || value <= 0) continue
    bucket.push(`${key}:${value}`)
  }
  return impact
}

/** Normalize catalog/deploy preview results into the uniform gate shape. */
export function catalogPreviewToGate(args: {
  ok: boolean
  dryRun: boolean
  applied: boolean
  errors: string[]
  counts: Record<string, number> | object
  warnings?: string[]
  impact?: PlatformImportImpact
  version?: { version: number }
}): PlatformImportGateResult {
  const counts = { ...(args.counts as Record<string, number>) }
  return gateResult({
    ok: args.ok,
    dryRun: args.dryRun,
    applied: args.applied,
    errors: args.errors,
    warnings: args.warnings,
    impact: args.impact ?? impactFromCounts(counts, "updates"),
    counts,
    version: args.version,
  })
}

/** Normalize entity-registry import responses into the uniform gate shape. */
export function entityImportToGate(args: {
  ok: boolean
  dryRun: boolean
  saved: Array<{ id: string; created: boolean }>
  skipped: Array<{ id: string; reason: string }>
  errors: Array<{ id: string | null; error: unknown }>
}): PlatformImportGateResult {
  const impact = emptyImpact()
  for (const row of args.saved) {
    if (row.created) impact.creates.push(row.id)
    else impact.updates.push(row.id)
  }
  for (const row of args.skipped) {
    impact.skips.push({ id: row.id, reason: row.reason })
  }
  const errors = args.errors.map((row) => {
    const detail =
      typeof row.error === "string"
        ? row.error
        : row.error && typeof row.error === "object" && "error" in row.error
          ? String((row.error as { error?: unknown }).error ?? "validation failed")
          : "validation failed"
    return row.id ? `${row.id}: ${detail}` : detail
  })
  return gateResult({
    ok: args.ok,
    dryRun: args.dryRun,
    applied: !args.dryRun && args.ok && args.saved.length > 0,
    errors,
    impact,
    counts: {
      creates: impact.creates.length,
      updates: impact.updates.length,
      skips: impact.skips.length,
      errors: errors.length,
    },
  })
}

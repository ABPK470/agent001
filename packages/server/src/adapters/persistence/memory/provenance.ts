/**
 * Memory provenance — Phase 5 of the prompt-as-policy elimination.
 *
 * Every persisted memory entry is stamped with:
 *   - `policyVersion` — the doctrine registry version string at ingest time.
 *   - `schemaFingerprint` — when the caller supplies one (catalog-aware
 *     ingest sites), a stable hash of the live schema shape so we can
 *     detect drift at retrieval time.
 *
 * At retrieval time entries whose stamps no longer match the current
 * environment are demoted (not deleted) so the ranking surface preserves
 * recent, in-policy knowledge without losing audit history.
 *
 * Design notes:
 *   - Demote, don't delete. A drifted entry may still be the only signal
 *     we have on an obscure topic — preserve it but lower its rank.
 *   - Stamps live in `metadata`. The schema column set stays untouched.
 *   - Legacy rows (no stamps) are treated as neutral — neither boosted
 *     nor demoted. They'll naturally age out via the staleness curve.
 *
 * @module
 */

import { mssqlPolicyVersion } from "@mia/agent"

/** Age beyond which an entry's combined score is gradually decayed. */
export const MEMORY_STALE_DAYS = 14

/** Hard floor on the staleness decay multiplier (never below this). */
const STALENESS_FLOOR = 0.1

/** Per-day decay slope past MEMORY_STALE_DAYS. 30d past => floor. */
const STALENESS_DECAY_PER_DAY = (1 - STALENESS_FLOOR) / 30

/** Multiplier applied when entry's policyVersion differs from current. */
const POLICY_MISMATCH_MULTIPLIER = 0.5

/** Multiplier applied when entry's schemaFingerprint differs from current. */
const SCHEMA_DRIFT_MULTIPLIER = 0.4

/** Metadata keys for provenance stamps. Stable wire format. */
export const PROVENANCE_KEYS = {
  policyVersion: "policyVersion",
  schemaFingerprint: "schemaFingerprint",
} as const

/** Returns the current MSSQL doctrine policy version. Pure, cheap. */
export function currentPolicyVersion(): string {
  return mssqlPolicyVersion()
}

/**
 * Stamps a metadata bag with the current `policyVersion` and (optionally)
 * the caller-supplied `schemaFingerprint`. Returns a NEW object; the
 * input is not mutated. Existing stamps in the input are preserved if
 * the caller already set them (e.g. ingestion of pre-stamped entries
 * from another component).
 */
export function stampProvenance(
  metadata: Record<string, unknown> | undefined,
  opts?: { schemaFingerprint?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(metadata ?? {}) }
  if (out[PROVENANCE_KEYS.policyVersion] == null) {
    out[PROVENANCE_KEYS.policyVersion] = currentPolicyVersion()
  }
  if (opts?.schemaFingerprint && out[PROVENANCE_KEYS.schemaFingerprint] == null) {
    out[PROVENANCE_KEYS.schemaFingerprint] = opts.schemaFingerprint
  }
  return out
}

/** Pure age helper. Returns whole days since `createdAtIso`. */
export function ageInDays(createdAtIso: string, now: Date = new Date()): number {
  const t = Date.parse(createdAtIso)
  if (!Number.isFinite(t)) return 0
  const ms = now.getTime() - t
  if (ms <= 0) return 0
  return Math.floor(ms / 86_400_000)
}

/**
 * Returns the multiplier to apply to an entry's combined score given
 * its stamps and the current environment. 1.0 means no change. Returns
 * `< 1.0` for staleness, policy drift, or schema drift. Never returns
 * `0` — drifted entries are demoted, not erased.
 */
export function provenanceMultiplier(
  metadata: Record<string, unknown>,
  createdAtIso: string,
  currentVersion: string,
  currentSchemaFingerprint: string | null,
  now: Date = new Date(),
): { multiplier: number; reasons: string[] } {
  let m = 1
  const reasons: string[] = []

  const entryVersion = metadata?.[PROVENANCE_KEYS.policyVersion]
  if (typeof entryVersion === "string" && entryVersion !== currentVersion) {
    m *= POLICY_MISMATCH_MULTIPLIER
    reasons.push("policy_mismatch")
  }

  const entrySchema = metadata?.[PROVENANCE_KEYS.schemaFingerprint]
  if (
    currentSchemaFingerprint &&
    typeof entrySchema === "string" &&
    entrySchema !== currentSchemaFingerprint
  ) {
    m *= SCHEMA_DRIFT_MULTIPLIER
    reasons.push("schema_drift")
  }

  const days = ageInDays(createdAtIso, now)
  if (days > MEMORY_STALE_DAYS) {
    const over = days - MEMORY_STALE_DAYS
    const decay = Math.max(STALENESS_FLOOR, 1 - over * STALENESS_DECAY_PER_DAY)
    m *= decay
    reasons.push(`age_${days}d`)
  }

  return { multiplier: m, reasons }
}

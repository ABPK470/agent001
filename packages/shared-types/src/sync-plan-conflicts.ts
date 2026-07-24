/**
 * Sync plan conflict kinds — wire identity + presentation labels.
 * One home for execute headlines, UI banners, and agent tags.
 */

export const SYNC_PLAN_CONFLICT_KINDS = [
  "scope_misattribution",
  "inbound_reference",
  "missing_parent"
] as const

export type SyncPlanConflictKind = (typeof SYNC_PLAN_CONFLICT_KINDS)[number]

/** Legacy plans omit `kind` — treat as scope misattribution. */
export const DEFAULT_SYNC_PLAN_CONFLICT_KIND: SyncPlanConflictKind = "scope_misattribution"

export interface SyncPlanConflictLabels {
  /** Env-sync table detail banner. */
  banner: string
  /** executeSync refuse headline. */
  executeHeadline: string
  /** Short phrase for mixed lists / logs. */
  short: string
}

export const SYNC_PLAN_CONFLICT_LABELS: Record<SyncPlanConflictKind, SyncPlanConflictLabels> = {
  scope_misattribution: {
    banner: "scope misattribution — blocks execute",
    executeHeadline: "Scope misattribution",
    short: "scope misattribution"
  },
  inbound_reference: {
    banner: "inbound references — blocks execute",
    executeHeadline: "Inbound reference blockers",
    short: "inbound references"
  },
  missing_parent: {
    banner: "missing parents — blocks execute",
    executeHeadline: "Missing parent blockers",
    short: "missing parents"
  }
}

const KIND_SET = new Set<string>(SYNC_PLAN_CONFLICT_KINDS)

export function normalizeSyncPlanConflictKind(
  kind: string | null | undefined
): SyncPlanConflictKind {
  if (kind && KIND_SET.has(kind)) return kind as SyncPlanConflictKind
  return DEFAULT_SYNC_PLAN_CONFLICT_KIND
}

export function syncPlanConflictKindsOf(
  conflicts: readonly { kind?: string | null }[]
): Set<SyncPlanConflictKind> {
  return new Set(conflicts.map((c) => normalizeSyncPlanConflictKind(c.kind)))
}

/** UI banner when one or more conflict kinds are present on a table. */
export function syncPlanConflictBannerLabel(
  conflicts: readonly { kind?: string | null }[]
): string {
  const kinds = syncPlanConflictKindsOf(conflicts)
  if (kinds.size !== 1) return "conflicts — blocks execute"
  return SYNC_PLAN_CONFLICT_LABELS[[...kinds][0]!].banner
}

/** executeSync refuse headline from the set of conflict kinds on a plan. */
export function syncPlanConflictExecuteHeadline(
  conflicts: readonly { kind?: string | null }[]
): string {
  const kinds = syncPlanConflictKindsOf(conflicts)
  if (kinds.size !== 1) return "Plan conflicts"
  return SYNC_PLAN_CONFLICT_LABELS[[...kinds][0]!].executeHeadline
}

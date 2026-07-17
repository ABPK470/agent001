/**
 * Reconciliation Proposer — shared types.
 *
 * The proposer is the "on-call DBA" loop: every N minutes scan an env-pair
 * for divergence, surface findings to a queue, let the LLM annotate them
 * with risk/rationale, rank for the human reviewer, and (after approval)
 * execute through the existing sync orchestrator with full evidence.
 *
 * Phase 1 (F1.1–F1.13) is built atop the Phase 0 entity registry so the
 * proposer iterates whatever entities are configured at runtime — not a
 * compile-time list.
 */

// ── Finding kinds — what the deterministic scan detects ──────────

export const ProposalKind = {
  /** Catalog drift between source and target (missing/extra/changed columns). */
  Drift: "drift",
  /** Rows present in source whose target equivalents differ. */
  OutOfSync: "out_of_sync",
  /** Entity rows present on source but not at all on target. */
  New: "new"
} as const

export type ProposalKind = (typeof ProposalKind)[keyof typeof ProposalKind]

// ── Risk tiers — produced by the annotator (F1.3) ────────────────

export const RiskTier = {
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical"
} as const

export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier]

/** Documented rubric for `riskScore` numeric breakdown by tier. */
export const RISK_SCORE_BANDS: Readonly<Record<RiskTier, readonly [number, number]>> = {
  low: [0, 24],
  medium: [25, 54],
  high: [55, 79],
  critical: [80, 100]
} as const

// ── Proposal lifecycle ───────────────────────────────────────────

export const ProposalStatus = {
  Open: "open",
  AwaitingApproval: "awaiting_approval",
  Previewed: "previewed",
  Executed: "executed",
  Dismissed: "dismissed",
  Snoozed: "snoozed",
  Superseded: "superseded",
  Failed: "failed"
} as const

export type ProposalStatus = (typeof ProposalStatus)[keyof typeof ProposalStatus]

/**
 * Allowed state-machine transitions. Any transition not listed here is
 * rejected by `assertTransition()` (used at every persistence call).
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  open: ["awaiting_approval", "previewed", "dismissed", "snoozed", "superseded", "executed", "failed"],
  awaiting_approval: ["previewed", "executed", "dismissed", "failed", "superseded"],
  previewed: ["awaiting_approval", "executed", "dismissed", "snoozed", "superseded", "failed"],
  snoozed: ["open", "dismissed", "superseded"],
  executed: [],
  dismissed: [],
  superseded: [],
  failed: ["open", "dismissed"]
} as const

export class IllegalProposalTransitionError extends Error {
  constructor(
    public from: ProposalStatus,
    public to: ProposalStatus
  ) {
    super(`Illegal proposal status transition: ${from} → ${to}`)
  }
}

export function assertProposalTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!PROPOSAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalProposalTransitionError(from, to)
  }
}

// ── Env-pair — the unit the proposer scans against ───────────────

export interface EnvPair {
  source: string
  target: string
}

export function formatEnvPair(p: EnvPair): string {
  return `${p.source}→${p.target}`
}

export function parseEnvPair(s: string): EnvPair {
  const [source, target] = s.split("→")
  if (!source || !target) throw new Error(`Invalid env-pair: "${s}" (expected "source→target")`)
  return { source, target }
}

// ── Proposer counts envelope — uniform across all kinds ──────────

export interface ProposalCounts {
  /** Rows present in source but absent on target. */
  insert: number
  /** Rows present in both whose content differs. */
  update: number
  /** Rows present on target but absent from source. Always 0 unless the
      entity's recipe explicitly opts into delete-style reconciliation. */
  delete: number
  /** Rows whose content matches; informational, not actionable. */
  unchanged: number
  /** Rows we could not classify (connection error, predicate failure). */
  unknown: number
}

export function emptyCounts(): ProposalCounts {
  return { insert: 0, update: 0, delete: 0, unchanged: 0, unknown: 0 }
}

export function totalActionable(c: ProposalCounts): number {
  return c.insert + c.update + c.delete
}

// ── Finding — output of F1.1 deterministic pass ──────────────────

export interface ProposerDriftDetail {
  issues: readonly string[]
}

export interface ProposerOutOfSyncDetail {
  perTable: ReadonlyArray<{ name: string; counts: ProposalCounts }>
}

export interface ProposerNewEntityDetail {
  sampleIds: readonly string[]
}

export type ProposerFindingDetail =
  | { kind: "drift"; drift: ProposerDriftDetail }
  | { kind: "out_of_sync"; outOfSync: ProposerOutOfSyncDetail }
  | { kind: "new"; newEntities: ProposerNewEntityDetail }

export interface ProposerFinding {
  envPair: EnvPair
  /** Entity machine id (from the registry); not a compile-time union. */
  entityType: string
  /** Specific row id within the entity (e.g. a Contract's ContractId). */
  entityId: string
  /** Human-friendly label captured at scan time so the UI doesn't need to refetch. */
  entityLabel: string
  kind: ProposalKind
  counts: ProposalCounts
  detail: ProposerFindingDetail
  /** SHA-256 over the canonical-JSON payload — used for dedup against open proposals. */
  fingerprint: string
  /** Snapshot of the entity-definition version that produced this finding. */
  entityDefVersion: number | null
  /** Time the deterministic pass observed this divergence. */
  observedAt: string
}

// ── Proposer run — F1.5 unit of work ─────────────────────────────

export const ProposerRunStatus = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled"
} as const

export type ProposerRunStatus = (typeof ProposerRunStatus)[keyof typeof ProposerRunStatus]

export interface ProposerRunCounts {
  scanned: number
  produced: number
  errors: number
}

export interface ProposerRun {
  id: string
  envPair: EnvPair
  startedAt: string
  finishedAt: string | null
  status: ProposerRunStatus
  counts: ProposerRunCounts
  error: string | null
  triggeredBy: string
  trigger: "schedule" | "manual" | "retry"
}

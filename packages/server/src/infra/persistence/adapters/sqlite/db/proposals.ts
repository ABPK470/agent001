/**
 * Persistence for F1 proposer / proposal lifecycle.
 *
 * Two physical tables:
 *  - `proposer_runs`        one row per pass (envelope of counts + status)
 *  - `sync_proposals`       one row per surviving finding (lifecycle row)
 *  - `sync_proposal_history` append-only transition log
 *
 * The lifecycle state-machine itself lives in `@mia/sync`
 * (`assertProposalTransition`); this module only persists. Any caller
 * that mutates `status` MUST call the assert first or use
 * `updateProposalStatus` which performs it inline.
 */

import {
  assertProposalTransition,
  ProposalStatus,
  ProposerRunStatus,
  type ProposalCounts,
  type ProposalKind,
  type ProposerFinding,
  type ProposerRun,
  type ProposerRunCounts,
  type RiskAnnotation,
  type RiskTier
} from "@mia/sync"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import { getPlatformStore } from "../platform-store.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

// ── proposer_runs ────────────────────────────────────────────────

export interface CreateProposerRunInput {
  tenantId: string
  source: string
  target: string
  triggeredBy: string
  trigger: ProposerRun["trigger"]
}

export function createProposerRun(input: CreateProposerRunInput): string {
  const id = randomUUID()
  const compiled = getPlatformDb()
    .insertInto("proposer_runs")
    .values({
      id,
      tenant_id: input.tenantId,
      source: input.source,
      target: input.target,
      started_at: sql`datetime('now')`,
      status: "pending",
      scanned: 0,
      produced: 0,
      errors: 0,
      triggered_by: input.triggeredBy,
      trigger: input.trigger,
    })
    .compile()
  runExec(compiled)
  return id
}

export function markProposerRunRunning(id: string): void {
  const compiled = getPlatformDb()
    .updateTable("proposer_runs")
    .set({ status: "running" })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .compile()
  runExec(compiled)
}

export interface FinishProposerRunInput {
  id: string
  status: Exclude<ProposerRunStatus, "pending" | "running">
  counts: ProposerRunCounts
  durationMs: number
  error: string | null
}

export function finishProposerRun(i: FinishProposerRunInput): void {
  const compiled = getPlatformDb()
    .updateTable("proposer_runs")
    .set({
      status: i.status,
      finished_at: sql`datetime('now')`,
      scanned: i.counts.scanned,
      produced: i.counts.produced,
      errors: i.counts.errors,
      duration_ms: i.durationMs,
      error: i.error,
    })
    .where("id", "=", i.id)
    .compile()
  runExec(compiled)
}

export interface ProposerRunRow {
  id: string
  tenant_id: string
  source: string
  target: string
  started_at: string
  finished_at: string | null
  status: ProposerRunStatus
  scanned: number
  produced: number
  errors: number
  duration_ms: number | null
  triggered_by: string
  trigger: ProposerRun["trigger"]
  error: string | null
}

export function getProposerRun(id: string): ProposerRunRow | null {
  const compiled = getPlatformDb()
    .selectFrom("proposer_runs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<ProposerRunRow>(compiled) ?? null
}

export function listProposerRuns(tenantId: string, limit = 50): ProposerRunRow[] {
  const compiled = getPlatformDb()
    .selectFrom("proposer_runs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("started_at", "desc")
    .limit(limit)
    .compile()
  return runAll<ProposerRunRow>(compiled)
}

/** Runs left in pending/running after a crash or restart. */
export function findStaleProposerRuns(): ProposerRunRow[] {
  const compiled = getPlatformDb()
    .selectFrom("proposer_runs")
    .selectAll()
    .where("status", "in", ["pending", "running"])
    .orderBy("started_at", "asc")
    .compile()
  return runAll<ProposerRunRow>(compiled)
}

// ── sync_proposals ───────────────────────────────────────────────

export interface ProposalRow {
  id: string
  tenant_id: string
  run_id: string
  fingerprint: string
  source: string
  target: string
  entity_type: string
  entity_id: string
  entity_label: string
  kind: ProposalKind
  counts_json: string
  detail_json: string
  entity_def_version: number | null
  observed_at: string
  enqueued_at: string
  status: ProposalStatus
  annotation_json: string | null
  annotation_failed_open: number
  risk_tier: RiskTier | null
  risk_score: number | null
  rank_score: number | null
  plan_id: string | null
  snooze_until: string | null
  superseded_by: string | null
  last_actor: string | null
  last_action: string | null
  last_action_at: string | null
}

/**
 * Insert proposals from a pass. Findings whose fingerprint matches an
 * already-open proposal are skipped (idempotent re-runs).
 * Returns ids of newly-inserted rows.
 */
export function ingestFindings(
  tenantId: string,
  runId: string,
  findings: readonly ProposerFinding[]
): string[] {
  const inserted: string[] = []
  getPlatformStore().transaction(() => {
    for (const f of findings) {
      const findOpen = getPlatformDb()
        .selectFrom("sync_proposals")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("fingerprint", "=", f.fingerprint)
        .where("status", "in", ["open", "awaiting_approval", "previewed", "snoozed"])
        .limit(1)
        .compile()
      if (runGet<{ id: string }>(findOpen)) continue

      const id = randomUUID()
      const ins = getPlatformDb()
        .insertInto("sync_proposals")
        .values({
          id,
          tenant_id: tenantId,
          run_id: runId,
          fingerprint: f.fingerprint,
          source: f.envPair.source,
          target: f.envPair.target,
          entity_type: f.entityType,
          entity_id: f.entityId,
          entity_label: f.entityLabel,
          kind: f.kind,
          counts_json: JSON.stringify(f.counts),
          detail_json: JSON.stringify(f.detail),
          entity_def_version: f.entityDefVersion,
          observed_at: f.observedAt,
          enqueued_at: sql`datetime('now')`,
          status: "open",
          annotation_failed_open: 0,
          last_action: "ingested",
          last_action_at: sql`datetime('now')`,
        })
        .compile()
      runExec(ins)

      const hist = getPlatformDb()
        .insertInto("sync_proposal_history")
        .values({
          proposal_id: id,
          from_status: null,
          to_status: "open",
          actor: "proposer",
          reason: "",
          detail_json: JSON.stringify({ runId, fingerprint: f.fingerprint }),
          at: sql`datetime('now')`,
        })
        .compile()
      runExec(hist)
      inserted.push(id)
    }
  })
  return inserted
}

export function getProposal(id: string): ProposalRow | null {
  const compiled = getPlatformDb()
    .selectFrom("sync_proposals")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<ProposalRow>(compiled) ?? null
}

export interface ListProposalsFilter {
  tenantId: string
  status?: readonly ProposalStatus[]
  riskTier?: readonly RiskTier[]
  source?: string
  target?: string
  entityType?: string
  limit?: number
  offset?: number
}

export function listProposals(f: ListProposalsFilter): ProposalRow[] {
  let query = getPlatformDb()
    .selectFrom("sync_proposals")
    .selectAll()
    .where("tenant_id", "=", f.tenantId)
  if (f.status?.length) {
    query = query.where("status", "in", [...f.status])
  }
  if (f.riskTier?.length) {
    query = query.where("risk_tier", "in", [...f.riskTier])
  }
  if (f.source) {
    query = query.where("source", "=", f.source)
  }
  if (f.target) {
    query = query.where("target", "=", f.target)
  }
  if (f.entityType) {
    query = query.where("entity_type", "=", f.entityType)
  }
  const compiled = query
    .orderBy(sql`coalesce(rank_score, 0)`, "desc")
    .orderBy("enqueued_at", "desc")
    .limit(f.limit ?? 100)
    .offset(f.offset ?? 0)
    .compile()
  return runAll<ProposalRow>(compiled)
}

export function countProposalsByStatus(tenantId: string): Record<ProposalStatus, number> {
  const compiled = getPlatformDb()
    .selectFrom("sync_proposals")
    .select(["status", sql<number>`count(*)`.as("n")])
    .where("tenant_id", "=", tenantId)
    .groupBy("status")
    .compile()
  const rows = runAll<{ status: ProposalStatus; n: number }>(compiled)
  const out: Partial<Record<ProposalStatus, number>> = {}
  for (const r of rows) out[r.status] = Number(r.n)
  for (const s of Object.values(ProposalStatus)) if (out[s] === undefined) out[s] = 0
  return out as Record<ProposalStatus, number>
}

// ── annotation + ranking persistence ────────────────────────────

export function saveAnnotation(id: string, annotation: RiskAnnotation, failedOpen: boolean): void {
  const compiled = getPlatformDb()
    .updateTable("sync_proposals")
    .set({
      annotation_json: JSON.stringify(annotation),
      annotation_failed_open: failedOpen ? 1 : 0,
      risk_tier: annotation.riskTier,
      risk_score: annotation.riskScore,
    })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function saveRankScore(id: string, score: number): void {
  const compiled = getPlatformDb()
    .updateTable("sync_proposals")
    .set({ rank_score: score })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

// ── lifecycle transitions ───────────────────────────────────────

export interface UpdateProposalStatusInput {
  id: string
  to: ProposalStatus
  actor: string
  reason?: string
  detail?: Record<string, unknown>
  planId?: string | null
  snoozeUntil?: string | null
  supersededBy?: string | null
}

export function updateProposalStatus(i: UpdateProposalStatusInput): ProposalRow {
  const row = getProposal(i.id)
  if (!row) throw new Error(`Proposal not found: ${i.id}`)
  assertProposalTransition(row.status, i.to)

  getPlatformStore().transaction(() => {
    const upd = getPlatformDb()
      .updateTable("sync_proposals")
      .set({
        status: i.to,
        // Match SQL COALESCE(?, col): null/undefined keeps the prior value.
        plan_id: i.planId ?? row.plan_id,
        snooze_until: i.snoozeUntil ?? row.snooze_until,
        superseded_by: i.supersededBy ?? row.superseded_by,
        last_actor: i.actor,
        last_action: i.to,
        last_action_at: sql`datetime('now')`,
      })
      .where("id", "=", i.id)
      .compile()
    runExec(upd)

    const hist = getPlatformDb()
      .insertInto("sync_proposal_history")
      .values({
        proposal_id: i.id,
        from_status: row.status,
        to_status: i.to,
        actor: i.actor,
        reason: i.reason ?? "",
        detail_json: JSON.stringify(i.detail ?? {}),
        at: sql`datetime('now')`,
      })
      .compile()
    runExec(hist)
  })
  return getProposal(i.id)!
}

export interface ProposalHistoryRow {
  id: number
  proposal_id: string
  from_status: ProposalStatus | null
  to_status: ProposalStatus
  actor: string
  reason: string
  detail_json: string
  at: string
}

export function listProposalHistory(id: string): ProposalHistoryRow[] {
  const compiled = getPlatformDb()
    .selectFrom("sync_proposal_history")
    .selectAll()
    .where("proposal_id", "=", id)
    .orderBy("at", "asc")
    .orderBy("id", "asc")
    .compile()
  return runAll<ProposalHistoryRow>(compiled)
}

// ── parse helpers (DB row → domain) ─────────────────────────────

export function parseCounts(row: ProposalRow): ProposalCounts {
  return JSON.parse(row.counts_json) as ProposalCounts
}

export function parseAnnotation(row: ProposalRow): RiskAnnotation | null {
  if (!row.annotation_json) return null
  return JSON.parse(row.annotation_json) as RiskAnnotation
}

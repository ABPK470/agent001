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
    type RiskTier,
} from "@mia/sync"
import { randomUUID } from "node:crypto"
import { getDb } from "./connection.js"

// ── proposer_runs ────────────────────────────────────────────────

export interface CreateProposerRunInput {
  tenantId:    string
  source:      string
  target:      string
  triggeredBy: string
  trigger:     ProposerRun["trigger"]
}

export function createProposerRun(input: CreateProposerRunInput): string {
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO proposer_runs (id, tenant_id, source, target, started_at, status,
                               scanned, produced, errors, triggered_by, trigger)
    VALUES (?, ?, ?, ?, datetime('now'), 'pending', 0, 0, 0, ?, ?)
  `).run(id, input.tenantId, input.source, input.target, input.triggeredBy, input.trigger)
  return id
}

export function markProposerRunRunning(id: string): void {
  getDb().prepare(
    `UPDATE proposer_runs SET status = 'running' WHERE id = ? AND status = 'pending'`,
  ).run(id)
}

export interface FinishProposerRunInput {
  id:         string
  status:     Exclude<ProposerRunStatus, "pending" | "running">
  counts:     ProposerRunCounts
  durationMs: number
  error:      string | null
}

export function finishProposerRun(i: FinishProposerRunInput): void {
  getDb().prepare(`
    UPDATE proposer_runs
       SET status = ?, finished_at = datetime('now'), scanned = ?, produced = ?,
           errors = ?, duration_ms = ?, error = ?
     WHERE id = ?
  `).run(i.status, i.counts.scanned, i.counts.produced, i.counts.errors,
         i.durationMs, i.error, i.id)
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
  return (getDb().prepare(`SELECT * FROM proposer_runs WHERE id = ?`).get(id) as ProposerRunRow | undefined) ?? null
}

export function listProposerRuns(tenantId: string, limit = 50): ProposerRunRow[] {
  return getDb().prepare(
    `SELECT * FROM proposer_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?`,
  ).all(tenantId, limit) as ProposerRunRow[]
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
  findings: readonly ProposerFinding[],
): string[] {
  const db = getDb()
  const findOpen = db.prepare(`
    SELECT id FROM sync_proposals
     WHERE tenant_id = ? AND fingerprint = ?
       AND status IN ('open','awaiting_approval','previewed','snoozed')
     LIMIT 1
  `)
  const ins = db.prepare(`
    INSERT INTO sync_proposals (
      id, tenant_id, run_id, fingerprint, source, target,
      entity_type, entity_id, entity_label, kind, counts_json, detail_json,
      entity_def_version, observed_at, status, last_action, last_action_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'ingested', datetime('now'))
  `)
  const insHistory = db.prepare(`
    INSERT INTO sync_proposal_history (proposal_id, from_status, to_status, actor, reason, detail_json)
    VALUES (?, NULL, 'open', ?, '', ?)
  `)
  const inserted: string[] = []
  const tx = db.transaction((items: readonly ProposerFinding[]) => {
    for (const f of items) {
      const dup = findOpen.get(tenantId, f.fingerprint) as { id: string } | undefined
      if (dup) continue
      const id = randomUUID()
      ins.run(
        id, tenantId, runId, f.fingerprint, f.envPair.source, f.envPair.target,
        f.entityType, f.entityId, f.entityLabel, f.kind,
        JSON.stringify(f.counts), JSON.stringify(f.detail),
        f.entityDefVersion, f.observedAt,
      )
      insHistory.run(id, "proposer", JSON.stringify({ runId, fingerprint: f.fingerprint }))
      inserted.push(id)
    }
  })
  tx(findings)
  return inserted
}

export function getProposal(id: string): ProposalRow | null {
  return (getDb().prepare(`SELECT * FROM sync_proposals WHERE id = ?`).get(id) as ProposalRow | undefined) ?? null
}

export interface ListProposalsFilter {
  tenantId:  string
  status?:   readonly ProposalStatus[]
  riskTier?: readonly RiskTier[]
  source?:   string
  target?:   string
  entityType?: string
  limit?:    number
  offset?:   number
}

export function listProposals(f: ListProposalsFilter): ProposalRow[] {
  const where: string[] = ["tenant_id = ?"]
  const args: unknown[] = [f.tenantId]
  if (f.status?.length)   { where.push(`status IN (${f.status.map(() => "?").join(",")})`);     args.push(...f.status) }
  if (f.riskTier?.length) { where.push(`risk_tier IN (${f.riskTier.map(() => "?").join(",")})`); args.push(...f.riskTier) }
  if (f.source)           { where.push("source = ?"); args.push(f.source) }
  if (f.target)           { where.push("target = ?"); args.push(f.target) }
  if (f.entityType)       { where.push("entity_type = ?"); args.push(f.entityType) }
  const limit  = f.limit  ?? 100
  const offset = f.offset ?? 0
  return getDb().prepare(`
    SELECT * FROM sync_proposals
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(rank_score, 0) DESC, enqueued_at DESC
     LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as ProposalRow[]
}

export function countProposalsByStatus(tenantId: string): Record<ProposalStatus, number> {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) AS n FROM sync_proposals WHERE tenant_id = ? GROUP BY status`,
  ).all(tenantId) as { status: ProposalStatus; n: number }[]
  const out: Partial<Record<ProposalStatus, number>> = {}
  for (const r of rows) out[r.status] = r.n
  // ensure every status key present
  for (const s of Object.values(ProposalStatus)) if (out[s] === undefined) out[s] = 0
  return out as Record<ProposalStatus, number>
}

// ── annotation + ranking persistence ────────────────────────────

export function saveAnnotation(
  id: string,
  annotation: RiskAnnotation,
  failedOpen: boolean,
): void {
  getDb().prepare(`
    UPDATE sync_proposals
       SET annotation_json = ?, annotation_failed_open = ?,
           risk_tier = ?, risk_score = ?
     WHERE id = ?
  `).run(JSON.stringify(annotation), failedOpen ? 1 : 0, annotation.riskTier, annotation.riskScore, id)
}

export function saveRankScore(id: string, score: number): void {
  getDb().prepare(`UPDATE sync_proposals SET rank_score = ? WHERE id = ?`).run(score, id)
}

// ── lifecycle transitions ───────────────────────────────────────

export interface UpdateProposalStatusInput {
  id:        string
  to:        ProposalStatus
  actor:     string
  reason?:   string
  detail?:   Record<string, unknown>
  planId?:   string | null
  snoozeUntil?: string | null
  supersededBy?: string | null
}

export function updateProposalStatus(i: UpdateProposalStatusInput): ProposalRow {
  const db = getDb()
  const row = getProposal(i.id)
  if (!row) throw new Error(`Proposal not found: ${i.id}`)
  assertProposalTransition(row.status, i.to)

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE sync_proposals
         SET status = ?,
             plan_id = COALESCE(?, plan_id),
             snooze_until = COALESCE(?, snooze_until),
             superseded_by = COALESCE(?, superseded_by),
             last_actor = ?, last_action = ?, last_action_at = datetime('now')
       WHERE id = ?
    `).run(i.to, i.planId ?? null, i.snoozeUntil ?? null, i.supersededBy ?? null,
           i.actor, i.to, i.id)
    db.prepare(`
      INSERT INTO sync_proposal_history (proposal_id, from_status, to_status, actor, reason, detail_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(i.id, row.status, i.to, i.actor, i.reason ?? "", JSON.stringify(i.detail ?? {}))
  })
  tx()
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
  return getDb().prepare(
    `SELECT * FROM sync_proposal_history WHERE proposal_id = ? ORDER BY at ASC, id ASC`,
  ).all(id) as ProposalHistoryRow[]
}

// ── parse helpers (DB row → domain) ─────────────────────────────

export function parseCounts(row: ProposalRow): ProposalCounts {
  return JSON.parse(row.counts_json) as ProposalCounts
}

export function parseAnnotation(row: ProposalRow): RiskAnnotation | null {
  if (!row.annotation_json) return null
  return JSON.parse(row.annotation_json) as RiskAnnotation
}

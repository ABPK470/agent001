/**
 * F1.12 — Prometheus metrics endpoint.
 *
 * We expose a curated set of F1 KPIs in the Prometheus text exposition
 * format so the existing ops dashboards can scrape them. Counters are
 * derived live from SQLite at scrape time — there is no in-process
 * counter state to keep in sync (and therefore no "lost-counter
 * after-restart" class of bugs).
 *
 * Documented metrics (see docs/sync/fork1/runbook.md):
 *
 *   mia_proposer_runs_total{status}
 *   mia_proposals_open{tenant, risk_tier}
 *   mia_proposals_status_total{status}
 *   mia_approvals_state_total{state}
 *   mia_evidence_envelopes_total
 *   mia_notification_log_total{status, channel}
 */

import { getDb } from "../db/connection.js"

export function renderPrometheusMetrics(): string {
  const lines: string[] = []
  push(lines, "mia_proposer_runs_total", "Total proposer runs by terminal status",
    rowsToLabels(getDb().prepare(`SELECT status, COUNT(*) AS n FROM proposer_runs GROUP BY status`).all() as Row[],
      (r) => ({ status: String(r.status) })))
  push(lines, "mia_proposals_open", "Currently-open proposals by tenant and risk tier",
    rowsToLabels(getDb().prepare(`
      SELECT tenant_id, COALESCE(risk_tier,'unannotated') AS risk_tier, COUNT(*) AS n
        FROM sync_proposals
       WHERE status IN ('open','awaiting_approval','previewed','snoozed')
       GROUP BY tenant_id, risk_tier
    `).all() as Row[], (r) => ({ tenant: String(r.tenant_id), risk_tier: String(r.risk_tier) })))
  push(lines, "mia_proposals_status_total", "Lifetime proposal count by status",
    rowsToLabels(getDb().prepare(`SELECT status, COUNT(*) AS n FROM sync_proposals GROUP BY status`).all() as Row[],
      (r) => ({ status: String(r.status) })))
  push(lines, "mia_approvals_state_total", "Lifetime approval count by state",
    rowsToLabels(getDb().prepare(`SELECT state, COUNT(*) AS n FROM sync_approvals GROUP BY state`).all() as Row[],
      (r) => ({ state: String(r.state) })))
  push(lines, "mia_evidence_envelopes_total", "Total signed evidence envelopes",
    [{ labels: {}, value: scalar("SELECT COUNT(*) AS n FROM sync_evidence") }])
  push(lines, "mia_notification_log_total", "Notification deliveries by status and channel",
    rowsToLabels(getDb().prepare(
      `SELECT status, channel, COUNT(*) AS n FROM notification_log GROUP BY status, channel`,
    ).all() as Row[], (r) => ({ status: String(r.status), channel: String(r.channel) })))
  return lines.join("\n") + "\n"
}

interface Row { [k: string]: string | number; n: number }
interface LabelledSample { labels: Record<string, string>; value: number }

function rowsToLabels(rows: readonly Row[], extract: (r: Row) => Record<string, string>): LabelledSample[] {
  return rows.map((r) => ({ labels: extract(r), value: Number(r.n) }))
}

function scalar(sql: string): number {
  const row = getDb().prepare(sql).get() as { n: number } | undefined
  return row ? Number(row.n) : 0
}

function push(out: string[], name: string, help: string, samples: readonly LabelledSample[]): void {
  out.push(`# HELP ${name} ${help}`)
  out.push(`# TYPE ${name} gauge`)
  if (samples.length === 0) {
    out.push(`${name} 0`)
    return
  }
  for (const s of samples) {
    const labelStr = Object.entries(s.labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")
    out.push(labelStr ? `${name}{${labelStr}} ${s.value}` : `${name} ${s.value}`)
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

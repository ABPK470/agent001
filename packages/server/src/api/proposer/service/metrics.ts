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

import {
  countApprovalsByState,
  countEvidenceEnvelopes,
  countNotificationLogByStatusChannel,
  countOpenProposalsByTenantRisk,
  countProposerRunsByStatus,
  countProposalsByStatusMetrics
} from "../../../infra/persistence/sqlite.js"

export function renderPrometheusMetrics(): string {
  const lines: string[] = []
  push(
    lines,
    "mia_proposer_runs_total",
    "Total proposer runs by terminal status",
    rowsToLabels(countProposerRunsByStatus(), (r) => ({ status: String(r.status) }))
  )
  push(
    lines,
    "mia_proposals_open",
    "Currently-open proposals by tenant and risk tier",
    rowsToLabels(countOpenProposalsByTenantRisk(), (r) => ({
      tenant: String(r.tenant_id),
      risk_tier: String(r.risk_tier)
    }))
  )
  push(
    lines,
    "mia_proposals_status_total",
    "Lifetime proposal count by status",
    rowsToLabels(countProposalsByStatusMetrics(), (r) => ({ status: String(r.status) }))
  )
  push(
    lines,
    "mia_approvals_state_total",
    "Lifetime approval count by state",
    rowsToLabels(countApprovalsByState(), (r) => ({ state: String(r.state) }))
  )
  push(lines, "mia_evidence_envelopes_total", "Total signed evidence envelopes", [
    { labels: {}, value: countEvidenceEnvelopes() }
  ])
  push(
    lines,
    "mia_notification_log_total",
    "Notification deliveries by status and channel",
    rowsToLabels(countNotificationLogByStatusChannel(), (r) => ({
      status: String(r.status),
      channel: String(r.channel)
    }))
  )
  return lines.join("\n") + "\n"
}

interface Row {
  [k: string]: string | number
  n: number
}
interface LabelledSample {
  labels: Record<string, string>
  value: number
}

function rowsToLabels(rows: readonly Row[], extract: (r: Row) => Record<string, string>): LabelledSample[] {
  return rows.map((r) => ({ labels: extract(r), value: Number(r.n) }))
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
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(",")
    out.push(labelStr ? `${name}{${labelStr}} ${s.value}` : `${name} ${s.value}`)
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

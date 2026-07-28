import { getDb } from "../connection.js"

export function countProposerRunsByStatus(): Array<{ status: string; n: number }> {
  return getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM proposer_runs GROUP BY status`)
    .all() as Array<{ status: string; n: number }>
}

export function countOpenProposalsByTenantRisk(): Array<{ tenant_id: string; risk_tier: string; n: number }> {
  return getDb()
    .prepare(
      `
      SELECT tenant_id, COALESCE(risk_tier,'unannotated') AS risk_tier, COUNT(*) AS n
        FROM sync_proposals
       WHERE status IN ('open','awaiting_approval','previewed','snoozed')
       GROUP BY tenant_id, risk_tier
    `
    )
    .all() as Array<{ tenant_id: string; risk_tier: string; n: number }>
}

export function countProposalsByStatus(): Array<{ status: string; n: number }> {
  return getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM sync_proposals GROUP BY status`)
    .all() as Array<{ status: string; n: number }>
}

export function countApprovalsByState(): Array<{ state: string; n: number }> {
  return getDb()
    .prepare(`SELECT state, COUNT(*) AS n FROM sync_approvals GROUP BY state`)
    .all() as Array<{ state: string; n: number }>
}

export function countEvidenceEnvelopes(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM sync_evidence_log`).get() as { n: number } | undefined
  return row ? Number(row.n) : 0
}

export function countNotificationLogByStatusChannel(): Array<{ status: string; channel: string; n: number }> {
  return getDb()
    .prepare(`SELECT status, channel, COUNT(*) AS n FROM notification_log GROUP BY status, channel`)
    .all() as Array<{ status: string; channel: string; n: number }>
}

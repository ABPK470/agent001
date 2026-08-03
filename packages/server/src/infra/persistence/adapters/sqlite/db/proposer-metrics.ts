import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runGetAsync } from "../../../schema/execute-async.js"

export async function countProposerRunsByStatus(): Promise<Array<{ status: string; n: number }>> {
  const compiled = getPlatformDb()
    .selectFrom("proposer_runs")
    .select(["status", sql<number>`count(*)`.as("n")])
    .groupBy("status")
    .compile()
  return (await runAllAsync<{ status: string; n: number }>(compiled)).map((r) => ({
    status: r.status,
    n: Number(r.n),
  }))
}

export async function countOpenProposalsByTenantRisk(): Promise<Array<{ tenant_id: string; risk_tier: string; n: number }>> {
  const compiled = getPlatformDb()
    .selectFrom("sync_proposals")
    .select([
      "tenant_id",
      sql<string>`coalesce(risk_tier, 'unannotated')`.as("risk_tier"),
      sql<number>`count(*)`.as("n"),
    ])
    .where("status", "in", ["open", "awaiting_approval", "previewed", "snoozed"])
    .groupBy("tenant_id")
    .groupBy(sql`coalesce(risk_tier, 'unannotated')`)
    .compile()
  return (await runAllAsync<{ tenant_id: string; risk_tier: string; n: number }>(compiled)).map((r) => ({
    tenant_id: r.tenant_id,
    risk_tier: r.risk_tier,
    n: Number(r.n),
  }))
}

export async function countProposalsByStatus(): Promise<Array<{ status: string; n: number }>> {
  const compiled = getPlatformDb()
    .selectFrom("sync_proposals")
    .select(["status", sql<number>`count(*)`.as("n")])
    .groupBy("status")
    .compile()
  return (await runAllAsync<{ status: string; n: number }>(compiled)).map((r) => ({
    status: r.status,
    n: Number(r.n),
  }))
}

export async function countApprovalsByState(): Promise<Array<{ state: string; n: number }>> {
  const compiled = getPlatformDb()
    .selectFrom("sync_approvals")
    .select(["state", sql<number>`count(*)`.as("n")])
    .groupBy("state")
    .compile()
  return (await runAllAsync<{ state: string; n: number }>(compiled)).map((r) => ({
    state: r.state,
    n: Number(r.n),
  }))
}

export async function countEvidenceEnvelopes(): Promise<number> {
  const compiled = getPlatformDb()
    .selectFrom("sync_evidence_log")
    .select(sql<number>`count(*)`.as("n"))
    .compile()
  const row = await runGetAsync<{ n: number | bigint }>(compiled)
  return Number(row?.n ?? 0)
}

export async function countNotificationLogByStatusChannel(): Promise<Array<{ status: string; channel: string; n: number }>> {
  const compiled = getPlatformDb()
    .selectFrom("notification_log")
    .select(["status", "channel", sql<number>`count(*)`.as("n")])
    .groupBy("status")
    .groupBy("channel")
    .compile()
  return (await runAllAsync<{ status: string; channel: string; n: number }>(compiled)).map((r) => ({
    status: r.status,
    channel: r.channel,
    n: Number(r.n),
  }))
}

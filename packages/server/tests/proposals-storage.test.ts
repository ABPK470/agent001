/**
 * F1.2 — proposals storage tests.
 *
 * Covers ingest dedupe, status transitions, annotation/rank persistence,
 * filtering, and history append.
 */

import { ProposalKind, ProposalStatus, RiskTier, type ProposerFinding } from "@mia/sync"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-proposals-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})
afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setup() {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  return import("../src/infra/persistence/db/proposals.js")
}

function finding(over: Partial<ProposerFinding> = {}): ProposerFinding {
  return {
    envPair: { source: "uat", target: "prod" },
    entityType: "contract",
    entityId: "c1",
    entityLabel: "Contract c1",
    kind: ProposalKind.OutOfSync,
    counts: { insert: 0, update: 1, delete: 0, unchanged: 100, unknown: 0 },
    detail: { kind: "out_of_sync", outOfSync: { perTable: [] } },
    fingerprint: "fp-c1",
    entityDefVersion: 1,
    observedAt: "2025-01-15T12:00:00.000Z",
    ...over
  }
}

describe("proposals storage (F1.2)", () => {
  it("creates a proposer run + ingests findings + dedupes by fingerprint", async () => {
    const m = await setup()
    const runId = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "manual"
    })
    const a = m.ingestFindings("_default", runId, [
      finding(),
      finding({ entityId: "c2", fingerprint: "fp-c2" })
    ])
    expect(a).toHaveLength(2)
    // re-ingest same fingerprints — should dedupe
    const b = m.ingestFindings("_default", runId, [
      finding(),
      finding({ entityId: "c2", fingerprint: "fp-c2" })
    ])
    expect(b).toHaveLength(0)
  })

  it("transitions status with append-only history", async () => {
    const m = await setup()
    const runId = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "manual"
    })
    const [id] = m.ingestFindings("_default", runId, [finding()])
    const updated = m.updateProposalStatus({
      id: id!,
      to: ProposalStatus.AwaitingApproval,
      actor: "alice"
    })
    expect(updated.status).toBe(ProposalStatus.AwaitingApproval)
    const hist = m.listProposalHistory(id!)
    expect(hist).toHaveLength(2) // initial 'open' + transition
    expect(hist[0]!.to_status).toBe("open")
    expect(hist[1]!.to_status).toBe("awaiting_approval")
  })

  it("rejects illegal transitions", async () => {
    const m = await setup()
    const runId = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "manual"
    })
    const [id] = m.ingestFindings("_default", runId, [finding()])
    m.updateProposalStatus({ id: id!, to: ProposalStatus.Dismissed, actor: "alice" })
    expect(() => m.updateProposalStatus({ id: id!, to: ProposalStatus.Executed, actor: "alice" })).toThrow()
  })

  it("persists annotation + rank score", async () => {
    const m = await setup()
    const runId = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "manual"
    })
    const [id] = m.ingestFindings("_default", runId, [finding()])
    m.saveAnnotation(
      id!,
      {
        riskTier: RiskTier.High,
        riskScore: 70,
        rationale: "X. Y. Z.",
        recommendedWindow: "any",
        dependsOn: [],
        warnings: []
      },
      false
    )
    m.saveRankScore(id!, 88.5)
    const row = m.getProposal(id!)
    expect(row?.risk_tier).toBe(RiskTier.High)
    expect(row?.rank_score).toBe(88.5)
    expect(m.parseAnnotation(row!)?.riskScore).toBe(70)
  })

  it("filters proposals by status and risk tier", async () => {
    const m = await setup()
    const runId = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "manual"
    })
    const ids = m.ingestFindings("_default", runId, [
      finding({ entityId: "c1", fingerprint: "fp1" }),
      finding({ entityId: "c2", fingerprint: "fp2" })
    ])
    m.updateProposalStatus({ id: ids[0]!, to: ProposalStatus.Dismissed, actor: "u" })
    const open = m.listProposals({ tenantId: "_default", status: [ProposalStatus.Open] })
    expect(open).toHaveLength(1)
    expect(open[0]!.id).toBe(ids[1])
  })

  it("counts proposals by status", async () => {
    const m = await setup()
    const runId = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "manual"
    })
    m.ingestFindings("_default", runId, [finding(), finding({ entityId: "c2", fingerprint: "fp2" })])
    const counts = m.countProposalsByStatus("_default")
    expect(counts[ProposalStatus.Open]).toBe(2)
    expect(counts[ProposalStatus.Executed]).toBe(0)
  })

  it("finishes a proposer run with totals", async () => {
    const m = await setup()
    const id = m.createProposerRun({
      tenantId: "_default",
      source: "uat",
      target: "prod",
      triggeredBy: "u",
      trigger: "schedule"
    })
    m.markProposerRunRunning(id)
    m.finishProposerRun({
      id,
      status: "completed",
      counts: { scanned: 10, produced: 3, errors: 0 },
      durationMs: 1234,
      error: null
    })
    const row = m.getProposerRun(id)
    expect(row?.status).toBe("completed")
    expect(row?.scanned).toBe(10)
    expect(row?.duration_ms).toBe(1234)
  })
})

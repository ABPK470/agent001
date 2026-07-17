/**
 * F1.7 — approval workflow tests.
 *
 * Covers state machine (single + dual), self-grant guard, duplicate-grant
 * guard, expiry handling, reject + bypass, policy upsert/list/get with
 * defaults, and HMAC token issue + consume + replay protection.
 */

import { RiskTier } from "@mia/sync"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-approvals-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  // FKs intentionally OFF: these tests focus on the approval state machine
  // in isolation, without needing to materialise full sync_proposals rows.
  testDb.pragma("foreign_keys = OFF")
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
  // _migrate re-enables FKs; the approval state-machine tests don't
  // exercise referential integrity — disable to avoid materialising a
  // full proposal fixture for every test.
  testDb.pragma("foreign_keys = OFF")
  return import("../src/infra/persistence/db/approvals.js")
}

const SECRET = "x".repeat(48)

describe("approval workflow (F1.7)", () => {
  it("default policy: low=none, medium=single, high/critical=dual", async () => {
    const m = await setup()
    expect(m.getApprovalPolicy("_default", "prod", RiskTier.Low).policy).toBe("none")
    expect(m.getApprovalPolicy("_default", "prod", RiskTier.Medium).policy).toBe("single")
    expect(m.getApprovalPolicy("_default", "prod", RiskTier.High).policy).toBe("dual")
    expect(m.getApprovalPolicy("_default", "prod", RiskTier.Critical).policy).toBe("dual")
  })

  it("upsertApprovalPolicy + listApprovalPolicies round-trip", async () => {
    const m = await setup()
    m.upsertApprovalPolicy(
      {
        tenantId: "_default",
        targetEnv: "prod",
        riskTier: RiskTier.Medium,
        policy: "dual",
        approvers: ["alice", "bob"],
        bypassRole: "admin"
      },
      "actor"
    )
    const list = m.listApprovalPolicies("_default")
    expect(list).toHaveLength(1)
    expect(list[0]?.policy).toBe("dual")
    expect(list[0]?.approvers).toEqual(["alice", "bob"])
  })

  it("single-policy grant transitions to granted", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: 3600_000,
      planId: "plan1",
      planHash: "h1"
    })
    const out = m.grantApproval({ approvalId: a.id, approver: "bob", planHashAtGrant: "h1" })
    expect(out.state).toBe("granted")
    expect(out.granted_by_1).toBe("bob")
  })

  it("dual-policy: first grant is partial, second completes", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "dual",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    const r1 = m.grantApproval({ approvalId: a.id, approver: "bob", planHashAtGrant: null })
    expect(r1.state).toBe("partially_granted")
    const r2 = m.grantApproval({ approvalId: a.id, approver: "carol", planHashAtGrant: null })
    expect(r2.state).toBe("granted")
    expect(r2.granted_by_2).toBe("carol")
  })

  it("rejects self-grant", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    expect(() =>
      m.grantApproval({ approvalId: a.id, approver: "alice", planHashAtGrant: null })
    ).toThrowError(/self_grant|requester/i)
  })

  it("rejects duplicate grant by same approver", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "dual",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    m.grantApproval({ approvalId: a.id, approver: "bob", planHashAtGrant: null })
    expect(() => m.grantApproval({ approvalId: a.id, approver: "bob", planHashAtGrant: null })).toThrowError(
      /duplicate_grant|already granted/i
    )
  })

  it("flips state to expired when TTL has passed", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: -1,
      planId: null,
      planHash: null
    })
    expect(() => m.grantApproval({ approvalId: a.id, approver: "bob", planHashAtGrant: null })).toThrowError(
      /expired|closed/i
    )
    expect(m.getApproval(a.id)?.state).toBe("expired")
  })

  it("reject + bypass record actor and reason", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    const rej = m.rejectApproval(a.id, "bob", "nope")
    expect(rej.state).toBe("rejected")
    expect(rej.reject_reason).toBe("nope")

    const a2 = m.createApproval({
      proposalId: "p2",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "dual",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    const byp = m.bypassApproval(a2.id, "admin", "incident")
    expect(byp.state).toBe("bypassed")
    expect(byp.bypass_reason).toBe("incident")
  })

  it("expireDueApprovals flips all overdue rows", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: -1000,
      planId: null,
      planHash: null
    })
    const n = m.expireDueApprovals()
    expect(n).toBe(1)
    expect(m.getApproval(a.id)?.state).toBe("expired")
  })

  it("HMAC token: issue + consume + replay rejection", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    const tok = m.issueApprovalToken({
      approvalId: a.id,
      action: "grant",
      issuedTo: "bob",
      ttlMs: 60_000,
      secret: SECRET
    })
    const consumed = m.consumeApprovalToken({ raw: tok.raw, secret: SECRET, by: "bob" })
    expect(consumed.approvalId).toBe(a.id)
    expect(consumed.action).toBe("grant")
    expect(() => m.consumeApprovalToken({ raw: tok.raw, secret: SECRET, by: "bob" })).toThrowError(
      /token_used|used/i
    )
  })

  it("HMAC token: tampered raw rejected", async () => {
    const m = await setup()
    const a = m.createApproval({
      proposalId: "p1",
      tenantId: "_default",
      requestedBy: "alice",
      policy: "single",
      ttlMs: 3600_000,
      planId: null,
      planHash: null
    })
    const tok = m.issueApprovalToken({
      approvalId: a.id,
      action: "grant",
      issuedTo: "bob",
      ttlMs: 60_000,
      secret: SECRET
    })
    expect(() => m.consumeApprovalToken({ raw: tok.raw + "x", secret: SECRET, by: "bob" })).toThrowError(
      /token_invalid|Unknown/i
    )
  })
})

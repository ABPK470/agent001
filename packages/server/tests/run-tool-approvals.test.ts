/**
 * Run tool approval DB persistence.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _migrate,
  _setDb,
  consumeRunToolApprovalGrant,
  getPendingRunToolApproval,
  getRunToolApproval,
  listApprovedToolGrantsForRuns,
  listPendingRunToolApprovalsForRuns,
  markRunToolApprovalApproved,
  markRunToolApprovalDenied,
  markRunWaitingForApproval,
  upsertPendingRunToolApproval,
} from "../src/infra/persistence/db/index.js"
import { seedRun, seedUser } from "./_fk-helpers.js"

const UPN = "alice@example.com"

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  _setDb(testDb)
  _migrate(testDb)
  seedUser(testDb, UPN)
})

afterEach(() => {
  testDb.close()
})

describe("run tool approvals DB", () => {
  it("upsertPendingRunToolApproval is idempotent per run+step", () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "running" })

    const first = upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://example.com" },
      reason: "outbound network",
      policyName: "approve_fetch",
    })
    const second = upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://other.example" },
      reason: "different reason",
      policyName: "other",
    })

    expect(second.id).toBe(first.id)
    expect(second.reason).toBe("outbound network")
    expect(listPendingRunToolApprovalsForRuns(["run-1"])).toHaveLength(1)
  })

  it("approve, deny, and consume grant transitions", () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })
    const pending = upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "write_file",
      args: { path: "/tmp/x.txt" },
      reason: "needs approval",
      policyName: "policy-a",
    })

    const approved = markRunToolApprovalApproved(pending.id, UPN)
    expect(approved?.status).toBe("approved")
    expect(approved?.resolvedBy).toBe(UPN)
    expect(getPendingRunToolApproval("run-1", "step-1")).toBeNull()

    consumeRunToolApprovalGrant(pending.id)
    expect(getRunToolApproval(pending.id)?.status).toBe("consumed")
    expect(listApprovedToolGrantsForRuns(["run-1"])).toHaveLength(0)

    seedRun(testDb, "run-2", { upn: UPN, status: "waiting_for_approval" })
    const deniedPending = upsertPendingRunToolApproval({
      runId: "run-2",
      stepId: "step-2",
      toolName: "shell",
      args: { command: "rm -rf /" },
      reason: "dangerous",
      policyName: "policy-b",
    })
    const denied = markRunToolApprovalDenied(deniedPending.id, UPN)
    expect(denied?.status).toBe("denied")
  })

  it("markRunWaitingForApproval updates run status", () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "running" })
    markRunWaitingForApproval("run-1")
    const row = testDb.prepare("SELECT status FROM runs WHERE id = ?").get("run-1") as { status: string }
    expect(row.status).toBe("waiting_for_approval")
  })
})

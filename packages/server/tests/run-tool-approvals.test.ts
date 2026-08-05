/**
 * Run tool approval DB persistence.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ToolApprovalGrantScope } from "@mia/shared-enums"
import {
  _migrate,
  _setDb,
  consumeRunToolApprovalGrant,
  expireApprovedToolGrantsForRuns,
  getPendingRunToolApproval,
  getRunToolApproval,
  listApprovedToolGrantsForRuns,
  listPendingRunToolApprovalsForRuns,
  markRunToolApprovalApproved,
  markRunToolApprovalDenied,
  markRunWaitingForApproval,
  upsertPendingRunToolApproval,
} from "../src/infra/persistence/adapters/sqlite/index.js"
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
  it("upsertPendingRunToolApproval is idempotent per run+step", async () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "running" })

    const first = await upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://example.com" },
      reason: "outbound network",
      policyName: "approve_fetch",
    })
    const second = await upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://other.example" },
      reason: "different reason",
      policyName: "other",
    })

    expect(second.id).toBe(first.id)
    expect(second.reason).toBe("outbound network")
    expect(second.grantScope).toBe(ToolApprovalGrantScope.Instance)
    expect(await listPendingRunToolApprovalsForRuns(["run-1"])).toHaveLength(1)
  })

  it("approve, deny, and consume grant transitions", async () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })
    const pending = await upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "write_file",
      args: { path: "/tmp/x.txt" },
      reason: "needs approval",
      policyName: "policy-a",
    })

    const approved = await markRunToolApprovalApproved(pending.id, UPN)
    expect(approved?.status).toBe("approved")
    expect(approved?.grantScope).toBe(ToolApprovalGrantScope.Instance)
    expect(approved?.resolvedBy).toBe(UPN)
    expect(await getPendingRunToolApproval("run-1", "step-1")).toBeNull()

    await consumeRunToolApprovalGrant(pending.id)
    expect((await getRunToolApproval(pending.id))?.status).toBe("consumed")
    expect(await listApprovedToolGrantsForRuns(["run-1"])).toHaveLength(0)

    seedRun(testDb, "run-2", { upn: UPN, status: "waiting_for_approval" })
    const deniedPending = await upsertPendingRunToolApproval({
      runId: "run-2",
      stepId: "step-2",
      toolName: "shell",
      args: { command: "rm -rf /" },
      reason: "dangerous",
      policyName: "policy-b",
    })
    const denied = await markRunToolApprovalDenied(deniedPending.id, UPN)
    expect(denied?.status).toBe("denied")
  })

  it("stores run-scoped grant and expires approved grants for a run", async () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })
    const pending = await upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://a.example" },
      reason: "outbound",
      policyName: "hosted_fetch",
    })

    const approved = await markRunToolApprovalApproved(
      pending.id,
      UPN,
      ToolApprovalGrantScope.Run,
    )
    expect(approved?.grantScope).toBe(ToolApprovalGrantScope.Run)
    expect(await listApprovedToolGrantsForRuns(["run-1"])).toHaveLength(1)

    await expireApprovedToolGrantsForRuns(["run-1"])
    expect(await listApprovedToolGrantsForRuns(["run-1"])).toHaveLength(0)
    expect((await getRunToolApproval(pending.id))?.status).toBe("consumed")
  })

  it("markRunWaitingForApproval updates run status", async () => {
    seedRun(testDb, "run-1", { upn: UPN, status: "running" })
    await markRunWaitingForApproval("run-1")
    const row = testDb.prepare("SELECT status FROM runs WHERE id = ?").get("run-1") as { status: string }
    expect(row.status).toBe("waiting_for_approval")
  })
})

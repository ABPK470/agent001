/**
 * Run tool approval application logic — orchestrator + SSE integration.
 */

import Database from "better-sqlite3"
import { EventType } from "@mia/agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentSession } from "../src/api/auth/index.js"
import { seedRun, seedUser } from "./_fk-helpers.js"

const UPN = "alice@example.com"

function session(): CurrentSession {
  return {
    sid: "sid-1",
    displayName: "Alice",
    upn: UPN,
    isAdmin: false,
    ip: "127.0.0.1",
    userAgent: "vitest",
  }
}

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  vi.restoreAllMocks()
})

async function setupDb(): Promise<void> {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  seedUser(testDb, UPN)
}

describe("run tool approval application", () => {
  it("approveRunToolStep grants approval, broadcasts resolved, resumes run", async () => {
    await setupDb()
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })
    const { upsertPendingRunToolApproval } = await import("../src/infra/persistence/db/index.js")
    const approval = upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://example.com" },
      reason: "network",
      policyName: "approve_fetch",
    })

    const { subscribeToEvents } = await import("../src/infra/events/broadcaster.js")
    const events: { type: string; data: Record<string, unknown> }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }))

    const resumeRun = vi.fn(() => "run-1-resumed")
    const orchestrator = { resumeRun, cancelRun: vi.fn() } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator

    try {
      const { approveRunToolStep } = await import("../src/api/runs/service/run-tool-approval.js")
      const result = approveRunToolStep(orchestrator, approval.id, session())

      expect(result).toEqual({ ok: true, runId: "run-1", resumedRunId: "run-1-resumed" })
      expect(resumeRun).toHaveBeenCalledWith("run-1", session())

      const resolved = events.find((e) => e.type === "approval.resolved")
      expect(resolved?.data).toMatchObject({
        runId: "run-1",
        stepId: "step-1",
        approvalId: approval.id,
        decision: "approved",
        by: UPN,
      })
    } finally {
      unsub()
    }
  })

  it("denyRunToolStep cancels run and broadcasts resolved + run.cancelled", async () => {
    await setupDb()
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })
    const { upsertPendingRunToolApproval } = await import("../src/infra/persistence/db/index.js")
    const approval = upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "write_file",
      args: { path: "/tmp/x" },
      reason: "blocked",
      policyName: "policy",
    })

    const { subscribeToEvents } = await import("../src/infra/events/broadcaster.js")
    const events: { type: string; data: Record<string, unknown> }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }))

    const cancelRun = vi.fn()
    const orchestrator = { resumeRun: vi.fn(), cancelRun } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator

    try {
      const { denyRunToolStep } = await import("../src/api/runs/service/run-tool-approval.js")
      const result = denyRunToolStep(orchestrator, approval.id, session(), "operator denied")

      expect(result).toEqual({ ok: true, runId: "run-1" })
      expect(cancelRun).toHaveBeenCalledWith("run-1")

      expect(events.some((e) => e.type === "approval.resolved" && e.data["decision"] === "denied")).toBe(true)
      expect(events.some((e) => e.type === EventType.RunCancelled)).toBe(true)

      const row = testDb.prepare("SELECT status FROM runs WHERE id = ?").get("run-1") as { status: string }
      expect(row.status).toBe("cancelled")
    } finally {
      unsub()
    }
  })

  it("listPendingToolApprovalsForSession scopes to waiting runs for the user", async () => {
    await setupDb()
    seedUser(testDb, "bob@example.com")
    seedRun(testDb, "run-wait", { upn: UPN, status: "waiting_for_approval" })
    seedRun(testDb, "run-done", { upn: UPN, status: "completed" })
    seedRun(testDb, "run-other", { upn: "bob@example.com", status: "waiting_for_approval" })

    const { upsertPendingRunToolApproval } = await import("../src/infra/persistence/db/index.js")
    const mine = upsertPendingRunToolApproval({
      runId: "run-wait",
      stepId: "step-1",
      toolName: "fetch_url",
      args: {},
      reason: "r",
      policyName: "p",
    })
    upsertPendingRunToolApproval({
      runId: "run-done",
      stepId: "step-2",
      toolName: "fetch_url",
      args: {},
      reason: "r",
      policyName: "p",
    })
    upsertPendingRunToolApproval({
      runId: "run-other",
      stepId: "step-3",
      toolName: "fetch_url",
      args: {},
      reason: "r",
      policyName: "p",
    })

    const { listPendingToolApprovalsForSession } = await import("../src/api/runs/service/run-tool-approval.js")
    const pending = listPendingToolApprovalsForSession(session())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe(mine.id)
  })

  it("consumeMatchingToolGrant matches tool name and normalized args", async () => {
    await setupDb()
    seedRun(testDb, "run-1", { upn: UPN, status: "running" })
    const { upsertPendingRunToolApproval, markRunToolApprovalApproved, getRunToolApproval } =
      await import("../src/infra/persistence/db/index.js")

    const approval = upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "write_file",
      args: { path: "/tmp/a.txt", content: "hi" },
      reason: "r",
      policyName: "p",
    })
    markRunToolApprovalApproved(approval.id, UPN)

    const { consumeMatchingToolGrant } = await import("../src/api/runs/service/run-tool-approval.js")
    consumeMatchingToolGrant("run-1", null, "write_file", { path: "/tmp/a.txt", content: "hi" })
    expect(getRunToolApproval(approval.id)?.status).toBe("consumed")
  })
})

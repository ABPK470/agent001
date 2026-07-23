/**
 * Tool approval end-to-end — finalization → SSE/notification → approve/deny.
 *
 * Exercises the full server-side path without Fastify or a real LLM:
 *   finalizeWaitingForApprovalRun → live events + notification
 *   → HTTP approve/deny → orchestrator resume/cancel + approval.resolved
 */

import { ApprovalRequiredError, EventType, RunStatus, type Agent } from "@mia/agent"
import Database from "better-sqlite3"
import Fastify from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentSession } from "../src/api/auth/index.js"
import { NotificationActionType } from "../src/internal/enums/notifications.js"
import { seedRun, seedSession, seedUser } from "./_fk-helpers.js"

const UPN = "alice@example.com"

function session(): CurrentSession {
  return {
    sid: "sid-e2e",
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
  vi.restoreAllMocks()
})

afterEach(() => {
  testDb.close()
})

async function setupDb(): Promise<void> {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  seedUser(testDb, UPN)
  seedSession(testDb, "sid-e2e", UPN)
}

describe("tool approval end-to-end", () => {
  it("finalize → SSE + notification → approve via route resumes run", async () => {
    await setupDb()
    seedRun(testDb, "run-e2e", { upn: UPN, status: "running", goal: "fetch report" })

    const { subscribeToEvents } = await import("../src/infra/events/broadcaster.js")
    const { finalizeWaitingForApprovalRun } = await import(
      "../src/runtime/execution/run-executor/finalization/waiting-approval.js"
    )
    const { listNotifications, getRun } = await import("../src/infra/persistence/db/index.js")

    const events: { type: string; data: Record<string, unknown> }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }))

    const error = new ApprovalRequiredError(
      "run-e2e",
      "step-fetch",
      "fetch_url",
      { url: "https://example.com/report" },
      "outbound network needs approval",
      "approve_fetch"
    )

    const boundSaveTrace = vi.fn()
    const persistCurrentRun = vi.fn()
    const runRepoSave = vi.fn(async () => {})

    try {
      await finalizeWaitingForApprovalRun(
        {
          request: {
            runId: "run-e2e",
            goal: "fetch report",
            tools: [],
            systemPrompt: undefined,
            priority: "normal",
          },
          runtime: {} as never,
          sideEffects: {
            auditLog: { history: vi.fn(async () => []) },
            runRepo: { save: runRepoSave },
          } as never,
        },
        {
          progress: { lastMessages: [], lastIteration: 2, prevTotalTokens: 0 },
          state: {
            stepCounter: 1,
            run: {
              id: "run-e2e",
              status: RunStatus.Running,
              steps: [],
              createdAt: new Date(),
              completedAt: null,
            },
          },
          boundSaveTrace,
          persistCurrentRun,
        } as never,
        { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, llmCalls: 0 } as Agent,
        error
      )

      expect(getRun("run-e2e")?.status).toBe("waiting_for_approval")
      expect(boundSaveTrace).toHaveBeenCalledWith(
        "run-e2e",
        expect.objectContaining({ text: expect.stringContaining("fetch_url") })
      )

      const approvalEvent = events.find((e) => e.type === EventType.ApprovalRequired)
      expect(approvalEvent?.data).toMatchObject({
        runId: "run-e2e",
        stepId: "step-fetch",
        toolName: "fetch_url",
        approvalId: expect.any(String),
      })

      const notificationEvent = events.find((e) => e.type === EventType.Notification)
      expect(notificationEvent?.data).toMatchObject({
        notificationType: EventType.ApprovalRequired,
        title: "Approval required",
        runId: "run-e2e",
      })

      const notifications = listNotifications()
      expect(notifications).toHaveLength(1)
      const actions = JSON.parse(notifications[0]!.actions) as Array<{ action: string }>
      expect(actions.map((a) => a.action)).toEqual([
        NotificationActionType.ApproveRunStep,
        NotificationActionType.DenyRunStep,
        NotificationActionType.ViewRun,
      ])

      const approvalId = approvalEvent!.data["approvalId"] as string
      const resumeRun = vi.fn(() => "run-e2e-resumed")
      const { registerRunRoutes } = await import("../src/api/runs/routes.js")
      const app = Fastify({ logger: false })
      app.addHook("onRequest", async (req) => {
        ;(req as unknown as { session: CurrentSession }).session = session()
      })
      registerRunRoutes(app, { resumeRun, cancelRun: vi.fn() } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator)
      await app.ready()

      const approve = await app.inject({
        method: "POST",
        url: `/api/runs/tool-approvals/${approvalId}/approve`,
      })
      expect(approve.statusCode).toBe(200)
      expect(approve.json()).toMatchObject({ ok: true, resumedRunId: "run-e2e-resumed" })
      expect(resumeRun).toHaveBeenCalledWith("run-e2e", session())

      expect(events.some((e) => e.type === "approval.resolved" && e.data["decision"] === "approved")).toBe(true)
      await app.close()
    } finally {
      unsub()
    }
  })

  it("deny via route cancels run and emits approval.resolved", async () => {
    await setupDb()
    seedRun(testDb, "run-deny", { upn: UPN, status: "waiting_for_approval" })

    const { upsertPendingRunToolApproval } = await import("../src/infra/persistence/db/index.js")
    const { subscribeToEvents } = await import("../src/infra/events/broadcaster.js")
    const { registerRunRoutes } = await import("../src/api/runs/routes.js")

    const approval = upsertPendingRunToolApproval({
      runId: "run-deny",
      stepId: "step-1",
      toolName: "write_file",
      args: { path: "/tmp/x" },
      reason: "blocked",
      policyName: "policy",
    })

    const events: { type: string; data: Record<string, unknown> }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }))

    const cancelRun = vi.fn()
    const app = Fastify({ logger: false })
    app.addHook("onRequest", async (req) => {
      ;(req as unknown as { session: CurrentSession }).session = session()
    })
    registerRunRoutes(app, { resumeRun: vi.fn(), cancelRun } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator)
    await app.ready()

    try {
      const deny = await app.inject({
        method: "POST",
        url: `/api/runs/tool-approvals/${approval.id}/deny`,
        payload: { reason: "not allowed" },
      })
      expect(deny.statusCode).toBe(200)
      expect(cancelRun).toHaveBeenCalledWith("run-deny")
      expect(events.some((e) => e.type === "approval.resolved" && e.data["decision"] === "denied")).toBe(true)

      const row = testDb.prepare("SELECT status FROM runs WHERE id = ?").get("run-deny") as { status: string }
      expect(row.status).toBe("cancelled")
    } finally {
      unsub()
      await app.close()
    }
  })
})

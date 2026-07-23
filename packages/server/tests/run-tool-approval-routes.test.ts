/**
 * HTTP routes for run tool approvals and notification actions.
 */

import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentSession } from "../src/api/auth/index.js"
import { seedRun, seedSession, seedUser } from "./_fk-helpers.js"

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
let app: FastifyInstance | null = null

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  vi.restoreAllMocks()
})

afterEach(async () => {
  if (app) await app.close()
  app = null
  testDb.close()
})

async function buildApp(orchestrator: import("../src/runtime/orchestrator.js").AgentOrchestrator) {
  const { _setDb, _migrate, upsertPendingRunToolApproval } = await import("../src/infra/persistence/db/index.js")
  const { registerRunRoutes } = await import("../src/api/runs/routes.js")
  const { registerNotificationRoutes } = await import("../src/api/notifications/routes.js")

  _setDb(testDb)
  _migrate(testDb)
  seedUser(testDb, UPN)
  seedSession(testDb, "sid-1", UPN)

  const fastify = Fastify({ logger: false })
  const currentSession = session()
  fastify.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = currentSession
  })
  registerRunRoutes(fastify, orchestrator)
  registerNotificationRoutes(fastify, orchestrator)
  await fastify.ready()

  return { app: fastify, upsertPendingRunToolApproval }
}

describe("run tool approval routes", () => {
  it("GET /api/runs/tool-approvals/pending returns pending approvals for the session", async () => {
    const resumeRun = vi.fn()
    const built = await buildApp({ resumeRun, cancelRun: vi.fn() } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator)
    app = built.app
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })

    const approval = built.upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: { url: "https://example.com" },
      reason: "network",
      policyName: "approve_fetch",
    })

    const res = await app.inject({ method: "GET", url: "/api/runs/tool-approvals/pending" })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; runId: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(approval.id)
  })

  it("POST approve and deny routes act on pending approvals", async () => {
    const resumeRun = vi.fn(() => "run-1-resumed")
    const cancelRun = vi.fn()
    const built = await buildApp({ resumeRun, cancelRun } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator)
    app = built.app
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })

    const approval = built.upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: {},
      reason: "network",
      policyName: "approve_fetch",
    })

    const approve = await app.inject({
      method: "POST",
      url: `/api/runs/tool-approvals/${approval.id}/approve`,
    })
    expect(approve.statusCode).toBe(200)
    expect(approve.json()).toMatchObject({ ok: true, runId: "run-1", resumedRunId: "run-1-resumed" })
    expect(resumeRun).toHaveBeenCalledWith("run-1", session())

    seedRun(testDb, "run-2", { upn: UPN, status: "waiting_for_approval" })
    const denyTarget = built.upsertPendingRunToolApproval({
      runId: "run-2",
      stepId: "step-2",
      toolName: "write_file",
      args: {},
      reason: "blocked",
      policyName: "policy",
    })

    const deny = await app.inject({
      method: "POST",
      url: `/api/runs/tool-approvals/${denyTarget.id}/deny`,
      payload: { reason: "no" },
    })
    expect(deny.statusCode).toBe(200)
    expect(deny.json()).toMatchObject({ ok: true, runId: "run-2" })
    expect(cancelRun).toHaveBeenCalledWith("run-2")
  })

  it("notification approve-run-step action delegates to approval service", async () => {
    const resumeRun = vi.fn(() => "run-1-resumed")
    const built = await buildApp({ resumeRun, cancelRun: vi.fn() } as unknown as import("../src/runtime/orchestrator.js").AgentOrchestrator)
    app = built.app
    seedRun(testDb, "run-1", { upn: UPN, status: "waiting_for_approval" })

    const approval = built.upsertPendingRunToolApproval({
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      args: {},
      reason: "network",
      policyName: "approve_fetch",
    })

    const { saveNotification } = await import("../src/infra/persistence/db/index.js")
    saveNotification({
      id: "note-1",
      type: "approval.required",
      title: "Approval required",
      message: 'Tool "fetch_url" needs approval: network',
      run_id: "run-1",
      step_id: "step-1",
      owner_upn: UPN,
      actions: JSON.stringify([
        {
          label: "Approve",
          action: "approve-run-step",
          data: { runId: "run-1", stepId: "step-1", approvalId: approval.id },
        },
      ]),
      read: 0,
      created_at: new Date().toISOString(),
    })

    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/note-1/action",
      payload: {
        action: "approve-run-step",
        data: { approvalId: approval.id, runId: "run-1", stepId: "step-1" },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, runId: "run-1", resumedRunId: "run-1-resumed" })
    expect(resumeRun).toHaveBeenCalled()
  })
})

import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentSession } from "../src/features/auth/index.js"

function fakeSession(over: Partial<CurrentSession> = {}): CurrentSession {
  return {
    sid: over.sid ?? "sid-browser",
    displayName: over.displayName ?? "Browser User",
    upn: over.upn ?? "browser.user@example.com",
    isAdmin: over.isAdmin ?? false,
    ip: over.ip ?? "127.0.0.1",
    userAgent: over.userAgent ?? "vitest"
  }
}

async function buildApp(session: CurrentSession | null) {
  const { registerRunRoutes } = await import("../src/features/runs/routes.js")
  const startRun = vi.fn(() => "run-123")
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    if (session) {
      ;(req as unknown as { session: CurrentSession }).session = session
    }
  })

  registerRunRoutes(app, {
    startRun,
    getRunWorkspaceDiff: () => null
  } as unknown as import("../src/features/runs/orchestrator.js").AgentOrchestrator)

  await app.ready()
  return { app, startRun }
}

describe("run routes", () => {
  let app: FastifyInstance | null = null

  afterEach(async () => {
    if (app) await app.close()
    app = null
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("forwards the authenticated session to orchestrator.startRun", async () => {
    const session = fakeSession({ sid: "sid-browser-1", upn: "alice@corp", displayName: "Alice" })
    const built = await buildApp(session)
    app = built.app

    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { goal: "continue the last revenue analysis" }
    })

    expect(res.statusCode).toBe(201)
    expect(built.startRun).toHaveBeenCalledTimes(1)
    const [goal, config, forwardedSession] = built.startRun.mock.calls[0] ?? []
    expect(goal).toBe("continue the last revenue analysis")
    expect(config).toEqual({ attachmentIds: [] })
    expect(forwardedSession).toMatchObject({
      sid: "sid-browser-1",
      upn: "alice@corp",
      displayName: "Alice"
    })
  })

  it("rejects unauthenticated callers with 401", async () => {
    const built = await buildApp(null)
    app = built.app

    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { goal: "anonymous run" }
    })

    expect(res.statusCode).toBe(401)
    expect(built.startRun).not.toHaveBeenCalled()
  })
})

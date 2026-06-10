import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CurrentSession } from "../src/features/auth/index.js"
import { seedSession, seedUser } from "./_fk-helpers.js"

let testDb: Database.Database

function adminSession(): CurrentSession {
  return {
    sid: "sid-admin",
    displayName: "Admin",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest"
  }
}

async function buildApp(session: CurrentSession): Promise<FastifyInstance> {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  const { registerApprovalRoutes } = await import("../src/features/approvals/routes.js")
  _setDb(testDb)
  _migrate(testDb)
  seedUser(testDb, session.upn, { displayName: session.displayName, isAdmin: session.isAdmin })
  seedSession(testDb, session.sid, session.upn)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
  })
  registerApprovalRoutes(app)
  await app.ready()
  return app
}

describe("approval policy routes", () => {
  beforeEach(() => {
    testDb = new Database(":memory:")
  })

  afterEach(() => {
    testDb.close()
  })

  it("GET /api/approvals/policies returns [] instead of 404 not found", async () => {
    const app = await buildApp(adminSession())
    const res = await app.inject({ method: "GET", url: "/api/approvals/policies" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it("PUT /api/approvals/policies persists and lists policy rows", async () => {
    const app = await buildApp(adminSession())
    const put = await app.inject({
      method: "PUT",
      url: "/api/approvals/policies",
      payload: { targetEnv: "UAT", riskTier: "high", kind: "dual", approvers: ["alice@example.com"], bypassRole: "admin" }
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ ok: true })

    const list = await app.inject({ method: "GET", url: "/api/approvals/policies" })
    expect(list.statusCode).toBe(200)
    const rows = list.json() as Array<{ targetEnv: string; riskTier: string; policy: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetEnv: "UAT", riskTier: "high", policy: "dual" })
    await app.close()
  })
})

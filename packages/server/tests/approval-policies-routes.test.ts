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

function seedConnection(name: string): void {
  testDb
    .prepare(
      `INSERT INTO sync_environments (name, body_json, created_at, updated_at, updated_by)
       VALUES (?, ?, datetime('now'), datetime('now'), 'test')`
    )
    .run(
      name,
      JSON.stringify({
        name,
        displayName: name,
        role: "target",
        ringOrder: 1,
        defaultAccessMode: "read_only",
        allowedOperations: ["read"],
      })
    )
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

  it("PUT /api/approvals/policies persists wildcard rules", async () => {
    const app = await buildApp(adminSession())
    const put = await app.inject({
      method: "PUT",
      url: "/api/approvals/policies",
      payload: { targetEnv: "*", riskTier: "high", kind: "dual", approvers: ["alice@example.com"], bypassRole: "admin" }
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ ok: true })

    const list = await app.inject({ method: "GET", url: "/api/approvals/policies" })
    expect(list.statusCode).toBe(200)
    const rows = list.json() as Array<{ targetEnv: string; riskTier: string; policy: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetEnv: "*", riskTier: "high", policy: "dual" })
    await app.close()
  })

  it("PUT rejects unknown target environments", async () => {
    const app = await buildApp(adminSession())
    const put = await app.inject({
      method: "PUT",
      url: "/api/approvals/policies",
      payload: { targetEnv: "not-a-connection", riskTier: "medium", kind: "single" }
    })
    expect(put.statusCode).toBe(400)
    expect(put.json()).toMatchObject({ error: expect.stringContaining("connection") })
    await app.close()
  })

  it("PUT accepts registered connection names", async () => {
    const app = await buildApp(adminSession())
    seedConnection("UAT")
    const put = await app.inject({
      method: "PUT",
      url: "/api/approvals/policies",
      payload: { targetEnv: "UAT", riskTier: "high", kind: "dual", approvers: [], bypassRole: "admin" }
    })
    expect(put.statusCode).toBe(200)

    const list = await app.inject({ method: "GET", url: "/api/approvals/policies" })
    const rows = list.json() as Array<{ targetEnv: string }>
    expect(rows.some((row) => row.targetEnv === "UAT")).toBe(true)
    await app.close()
  })

  it("DELETE /api/approvals/policies removes a saved rule", async () => {
    const app = await buildApp(adminSession())
    await app.inject({
      method: "PUT",
      url: "/api/approvals/policies",
      payload: { targetEnv: "*", riskTier: "medium", kind: "single" }
    })
    const del = await app.inject({
      method: "DELETE",
      url: "/api/approvals/policies?targetEnv=*&riskTier=medium"
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })

    const list = await app.inject({ method: "GET", url: "/api/approvals/policies" })
    expect(list.json()).toEqual([])
    await app.close()
  })
})

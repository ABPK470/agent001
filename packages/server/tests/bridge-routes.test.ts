import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"

import type { AgentHost } from "@mia/agent"
import type { ConnectorInfo, MoveSummary } from "@mia/shared-types"
import type { CurrentSession } from "../src/api/auth/index.js"
import { registerBridgeRoutes } from "../src/api/connectors/transport/bridge.js"

function adminSession(): CurrentSession {
  return {
    sid: "sid-admin",
    displayName: "Admin",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest",
  }
}

function anonSession(): CurrentSession {
  return { ...adminSession(), isAdmin: false }
}

interface MockPort {
  listAdapters: () => ConnectorInfo[]
  moveData: (s: { connectorId: string }, t: { connectorId: string }, o: { transform?: unknown }) => Promise<MoveSummary>
  previewMove: (s: { connectorId: string }, o: { transform?: unknown; limit?: number }) => Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>
}

function hostWith(port: MockPort | null): AgentHost {
  return { connectors: { port: { value: port } } } as unknown as AgentHost
}

async function buildApp(session: CurrentSession, port: MockPort | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
  })
  registerBridgeRoutes(app, hostWith(port))
  await app.ready()
  return app
}

const adapters: ConnectorInfo[] = [
  {
    id: "pg-src",
    kind: "postgres",
    name: "pg-src",
    displayName: "Postgres source",
    enabled: true,
    capabilities: { read: true, write: false, query: true },
  },
]

describe("bridge routes", () => {
  it("lists connectors from the port", async () => {
    const app = await buildApp(
      adminSession(),
      {
        listAdapters: () => adapters,
        moveData: async () => ({}) as MoveSummary,
        previewMove: async () => ({ rows: [], truncated: false }),
      },
    )
    const res = await app.inject({ method: "GET", url: "/api/bridge/connectors" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ connectors: adapters })
    await app.close()
  })

  it("returns an empty list when the port is not wired", async () => {
    const app = await buildApp(adminSession(), null)
    const res = await app.inject({ method: "GET", url: "/api/bridge/connectors" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ connectors: [] })
    await app.close()
  })

  it("rejects non-admin", async () => {
    const app = await buildApp(
      anonSession(),
      {
        listAdapters: () => adapters,
        moveData: async () => ({}) as MoveSummary,
        previewMove: async () => ({ rows: [], truncated: false }),
      },
    )
    const list = await app.inject({ method: "GET", url: "/api/bridge/connectors" })
    expect(list.statusCode).toBe(403)
    const run = await app.inject({
      method: "POST",
      url: "/api/bridge/run",
      payload: { source: { connectorId: "a", spec: { kind: "sql", sql: "SELECT 1" } }, target: { connectorId: "b", spec: { kind: "sql", table: "t", mode: "append" } } },
    })
    expect(run.statusCode).toBe(403)
    await app.close()
  })

  it("runs a move and returns the summary", async () => {
    let captured: { source: string; target: string; transform?: unknown } | null = null
    const app = await buildApp(adminSession(), {
      listAdapters: () => adapters,
      moveData: async (s, t, o) => {
        captured = { source: s.connectorId, target: t.connectorId, transform: o?.transform }
        return { status: "completed", rowsRead: 5, rowsWritten: 5, errors: [], failedAtRow: null }
      },
      previewMove: async () => ({ rows: [], truncated: false }),
    })
    const res = await app.inject({
      method: "POST",
      url: "/api/bridge/run",
      payload: {
        source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT 1" } },
        target: { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "replace" } },
        transform: { columns: [{ from: "a", to: "b" }] },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: "completed", rowsRead: 5, rowsWritten: 5 })
    expect(captured).toEqual({
      source: "pg-src",
      target: "ms-tgt",
      transform: { columns: [{ from: "a", to: "b" }] },
    })
    await app.close()
  })

  it("validates run payload", async () => {
    const app = await buildApp(adminSession(), {
      listAdapters: () => adapters,
      moveData: async () => ({}) as MoveSummary,
      previewMove: async () => ({ rows: [], truncated: false }),
    })
    const res = await app.inject({
      method: "POST",
      url: "/api/bridge/run",
      payload: { source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT 1" } } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining("target") })
    await app.close()
  })

  it("returns 503 when the port is not wired for run/preview", async () => {
    const app = await buildApp(adminSession(), null)
    const run = await app.inject({
      method: "POST",
      url: "/api/bridge/run",
      payload: {
        source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT 1" } },
        target: { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "append" } },
      },
    })
    expect(run.statusCode).toBe(503)
    await app.close()
  })

  it("previews rows without writing", async () => {
    let moveCalled = false
    let previewCaptured: { limit?: number; transform?: unknown } | null = null
    const app = await buildApp(adminSession(), {
      listAdapters: () => adapters,
      moveData: async () => {
        moveCalled = true
        return { status: "completed", rowsRead: 0, rowsWritten: 0, errors: [], failedAtRow: null }
      },
      previewMove: async (_s, o) => {
        previewCaptured = { limit: o?.limit, transform: o?.transform }
        return { rows: [{ a: 1 }, { a: 2 }], truncated: true }
      },
    })
    const res = await app.inject({
      method: "POST",
      url: "/api/bridge/preview",
      payload: {
        source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT a FROM t" } },
        transform: { columns: [{ from: "a", to: "b" }] },
        limit: 2,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ rows: [{ a: 1 }, { a: 2 }], truncated: true })
    expect(moveCalled).toBe(false)
    expect(previewCaptured).toEqual({ limit: 2, transform: { columns: [{ from: "a", to: "b" }] } })
    await app.close()
  })

  it("surfaces port errors as 400", async () => {
    const app = await buildApp(adminSession(), {
      listAdapters: () => adapters,
      moveData: async () => {
        throw new Error("boom")
      },
      previewMove: async () => ({ rows: [], truncated: false }),
    })
    const res = await app.inject({
      method: "POST",
      url: "/api/bridge/run",
      payload: {
        source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT 1" } },
        target: { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "append" } },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: "boom" })
    await app.close()
  })
})

afterEach(() => {
  // no shared state between tests; placeholder for symmetry with sibling suites
})

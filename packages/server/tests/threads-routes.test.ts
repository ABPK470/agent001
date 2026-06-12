import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentSession } from "../src/features/auth/index.js"

function fakeSession(over: Partial<CurrentSession> = {}): CurrentSession {
  return {
    sid: over.sid ?? "sid-browser",
    displayName: over.displayName ?? "Alice",
    upn: over.upn ?? "alice@example.com",
    isAdmin: over.isAdmin ?? false,
    ip: over.ip ?? "127.0.0.1",
    userAgent: over.userAgent ?? "vitest"
  }
}

let db: Database.Database
let dataDir: string
let originalDataDir: string | undefined

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-threads-"))
  originalDataDir = process.env["MIA_DATA_DIR"]
  process.env["MIA_DATA_DIR"] = dataDir
  db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(db)
  _migrate(db)
  const { seedUser } = await import("./_fk-helpers.js")
  seedUser(db, "alice@example.com")
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = originalDataDir
})

async function buildApp(session: CurrentSession | null) {
  const { registerThreadRoutes } = await import("../src/features/threads/routes.js")
  const { registerRunRoutes } = await import("../src/features/runs/routes.js")
  const startRun = vi.fn(() => "run-new")
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    if (session) {
      ;(req as unknown as { session: CurrentSession }).session = session
    }
  })
  const orchestrator = {
    startRun,
    getRunWorkspaceDiff: () => null
  } as unknown as import("../src/features/runs/orchestrator.js").AgentOrchestrator
  registerThreadRoutes(app, orchestrator)
  registerRunRoutes(app, orchestrator)
  await app.ready()
  return { app, startRun }
}

describe("thread routes", () => {
  let app: FastifyInstance | null = null

  afterEach(async () => {
    if (app) await app.close()
    app = null
    vi.restoreAllMocks()
  })

  it("creates and lists threads for the authenticated user", async () => {
    const built = await buildApp(fakeSession())
    app = built.app

    const createRes = await app.inject({
      method: "POST",
      url: "/api/threads",
      payload: { title: "Revenue analysis" }
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as { id: string; title: string }
    expect(created.title).toBe("Revenue analysis")

    const listRes = await app.inject({ method: "GET", url: "/api/threads" })
    expect(listRes.statusCode).toBe(200)
    const threads = listRes.json() as Array<{ id: string; title: string }>
    expect(threads.some((t) => t.id === created.id)).toBe(true)
  })

  it("excludes the workspace thread from GET /api/threads", async () => {
    const built = await buildApp(fakeSession())
    app = built.app
    const { getWorkspaceThread } = await import("../src/platform/persistence/db/threads.js")

    const workspace = getWorkspaceThread("alice@example.com")
    expect(workspace).toBeDefined()

    const listRes = await app.inject({ method: "GET", url: "/api/threads" })
    const threads = listRes.json() as Array<{ id: string }>
    expect(threads.some((t) => t.id === workspace!.id)).toBe(false)
  })

  it("forwards threadId to orchestrator.startRun", async () => {
    const built = await buildApp(fakeSession())
    app = built.app

    const createRes = await app.inject({ method: "POST", url: "/api/threads", payload: {} })
    const threadId = (createRes.json() as { id: string }).id

    const runRes = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { goal: "hello", threadId }
    })
    expect(runRes.statusCode).toBe(201)
    expect(built.startRun).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ threadId }),
      expect.any(Object)
    )
  })
})

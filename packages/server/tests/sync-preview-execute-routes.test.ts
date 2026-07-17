import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentHost } from "@mia/agent"
import type { CurrentSession } from "../src/api/auth/index.js"
import { writeEntityBundle } from "../../sync/src/test-support/entity-fixtures.js"
import { buildEntityPlan } from "../../sync/src/test-support/plan-fixtures.js"
import { ENTITY_SPECS } from "../../sync/src/test-support/entity-fixtures.js"
import { createPublishedSyncDefinitionRegistry } from "@mia/sync"

const previewSyncMock = vi.fn()
const executeSyncMock = vi.fn()
const loadPlanMock = vi.fn()

vi.mock("@mia/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mia/sync")>()
  return {
    ...actual,
    previewSync: (...args: unknown[]) => previewSyncMock(...args),
    executeSync: (...args: unknown[]) => executeSyncMock(...args),
    loadPlan: (...args: unknown[]) => loadPlanMock(...args)
  }
})

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function adminSession(): CurrentSession {
  return {
    sid: "sid-admin",
    displayName: "Admin User",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest"
  }
}

function createHost(root: string): AgentHost {
  return {
    mssql: { databases: new Map(), defaultConnection: { value: "DEV" } },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null },
        actorUpn: null
      },
      governance: { freezeWindowsReader: () => [] },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: { dbProjectRoot: root, publishedDefinitions: createPublishedSyncDefinitionRegistry() }
    }
  } as unknown as AgentHost
}

async function buildApp(session: CurrentSession): Promise<{ app: FastifyInstance; host: AgentHost }> {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  const { registerSyncRoutes } = await import("../src/api/sync/routes.js")
  const { seedUser, seedSession } = await import("./_fk-helpers.js")

  _setDb(testDb)
  _migrate(testDb)
  const host = createHost(projectRoot)
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
    seedUser(testDb, session.upn, { displayName: session.displayName, isAdmin: session.isAdmin })
    seedSession(testDb, session.sid, session.upn)
  })
  registerSyncRoutes(app, projectRoot, host)
  await app.ready()
  return { app, host }
}

beforeEach(() => {
  vi.clearAllMocks()
  dataDir = mkdtempSync(join(tmpdir(), "mia-sync-pe-data-"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-sync-pe-root-"))
  mkdirSync(join(projectRoot, "deploy", "sync", "artifacts"), { recursive: true })
  writeEntityBundle(projectRoot, ["contract", "dataset", "rule", "pipelineActivity"])
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("POST /api/sync/preview", () => {
  it("returns plan summary for contract DEV→UAT", async () => {
    const plan = buildEntityPlan({
      planId: "plan-api-1",
      entityType: "contract",
      entityId: 4368,
      spec: ENTITY_SPECS.contract
    })
    previewSyncMock.mockResolvedValue(plan)
    const { app } = await buildApp(adminSession())

    const res = await app.inject({
      method: "POST",
      url: "/api/sync/preview",
      payload: { entityType: "contract", entityId: 4368, source: "DEV", target: "UAT" }
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { planId: string; totals: { insert: number } }
    expect(body.planId).toBe("plan-api-1")
    expect(previewSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "contract",
        entityId: 4368,
        source: "DEV",
        target: "UAT"
      })
    )
    await app.close()
  })

  it("returns 400 when preview orchestrator throws", async () => {
    previewSyncMock.mockRejectedValue(new Error("target-only environment"))
    const { app } = await buildApp(adminSession())

    const res = await app.inject({
      method: "POST",
      url: "/api/sync/preview",
      payload: { entityType: "contract", entityId: 1, source: "DEV", target: "UAT" }
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining("target-only") })
    await app.close()
  })

  it("accepts optional enabledOptionalTables", async () => {
    const plan = buildEntityPlan({
      entityType: "contract",
      entityId: 1,
      spec: ENTITY_SPECS.contract
    })
    previewSyncMock.mockResolvedValue(plan)
    const { app } = await buildApp(adminSession())

    const res = await app.inject({
      method: "POST",
      url: "/api/sync/preview",
      payload: {
        entityType: "contract",
        entityId: 1,
        source: "DEV",
        target: "UAT",
        enabledOptionalTables: ["core.Step"]
      }
    })

    expect(res.statusCode).toBe(200)
    expect(previewSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabledOptionalTables: ["core.Step"] })
    )
    await app.close()
  })
})

describe("POST /api/sync/execute/:planId", () => {
  it("runs execute with confirm and returns success", async () => {
    executeSyncMock.mockResolvedValue({ planId: "plan-exec-1", success: true })
    loadPlanMock.mockReturnValue(
      buildEntityPlan({
        planId: "plan-exec-1",
        entityType: "dataset",
        entityId: 10,
        spec: ENTITY_SPECS.dataset
      })
    )
    const { app } = await buildApp(adminSession())

    const res = await app.inject({
      method: "POST",
      url: "/api/sync/execute/plan-exec-1"
    })

    expect(res.statusCode).toBe(200)
    expect(executeSyncMock).toHaveBeenCalledWith(
      "plan-exec-1",
      expect.objectContaining({ confirm: true, userUpn: "admin@example.com" })
    )
    await app.close()
  })

  it("returns failure payload when execute reports error", async () => {
    executeSyncMock.mockResolvedValue({
      planId: "plan-exec-2",
      success: false,
      error: "Scope misattribution"
    })
    loadPlanMock.mockReturnValue(
      buildEntityPlan({
        planId: "plan-exec-2",
        entityType: "contract",
        entityId: 2,
        spec: ENTITY_SPECS.contract
      })
    )
    const { app } = await buildApp(adminSession())

    const res = await app.inject({
      method: "POST",
      url: "/api/sync/execute/plan-exec-2"
    })

    expect(res.statusCode).toBe(500)
    const body = res.json() as { success: boolean; error?: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain("Scope misattribution")
    await app.close()
  })

  it("returns 400 when execute throws before result", async () => {
    executeSyncMock.mockRejectedValue(new Error("Plan expired"))
    loadPlanMock.mockReturnValue(
      buildEntityPlan({
        planId: "plan-exec-3",
        entityType: "rule",
        entityId: 3,
        spec: ENTITY_SPECS.rule
      })
    )
    const { app } = await buildApp(adminSession())

    const res = await app.inject({
      method: "POST",
      url: "/api/sync/execute/plan-exec-3"
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining("Plan expired") })
    await app.close()
  })
})

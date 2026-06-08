import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CurrentSession } from "../src/features/auth/context.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const repoRoot = resolve(import.meta.dirname, "../../..")

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

async function buildApp(session: CurrentSession): Promise<FastifyInstance> {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  const db = await import("../src/platform/persistence/sqlite.js")
  const { registerEntityRegistryRoutes } = await import("../src/features/sync/definitions-routes.js")
  const { seedUser, seedSession } = await import("./_fk-helpers.js")

  _setDb(testDb)
  _migrate(testDb)

  db.saveEntityDefinition({
    tenantId: "_default",
    actor: session.upn,
    reason: "seed",
    def: {
      id: "contract",
      tenantId: "_default",
      displayName: "Contract",
      description: "Contract entity",
      rootTable: "core.Contract",
      idColumn: "contractId",
      labelColumn: "name",
      selfJoinColumn: null,
      tables: [
        {
          name: "core.Contract",
          scope: { kind: "rootPk", column: "contractId" },
          executionOrder: 0,
          scd2Override: null,
          verified: true,
          archiveTable: null,
          note: null,
          provenance: { kind: "manual" },
          scopeColumn: "contractId",
          source: "manual",
          groundedByPipeline: false,
          enabledByDefault: true,
          userControllable: false
        }
      ],
      policies: { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1 },
      scd2: { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null },
      lineageRefs: [],
      provenance: { kind: "manual" },
      legacyEntrySproc: null,
      reverseOrder: ["core.Contract"],
      discrepancies: [],
      version: 1,
      versionLabel: null,
      createdBy: session.upn,
      reason: "seed",
      createdAt: new Date().toISOString(),
      retiredAt: null
    }
  })

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
    seedUser(testDb, session.upn, {
      displayName: session.displayName,
      isAdmin: session.isAdmin
    })
    seedSession(testDb, session.sid, session.upn)
  })
  registerEntityRegistryRoutes(app, repoRoot)
  await app.ready()
  return app
}

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "mia-entity-registry-scaffold-data-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("entity registry scaffold route", () => {
  it("exports a repo-definition draft from the saved registry record", async () => {
    const app = await buildApp(adminSession())

    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/entities/contract/scaffold-sync-definition"
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      suggestedPath: string
      definition: {
        id: string
        bindings: { serviceProfileRef: string; environmentPolicyRef: string }
        executionFlow: { steps: Array<{ kind: string }> }
      }
      stderr: string[]
    }
    expect(body.suggestedPath).toBe("deploy/sync/artifacts/entities/contract.json")
    expect(body.definition.id).toBe("contract")
    expect(body.definition.bindings).toEqual({
      serviceProfileRef: "default",
      environmentPolicyRef: "default"
    })
    expect(body.definition.executionFlow.steps.map((step) => step.kind)).toEqual([
      "auditCheck",
      "targetLock",
      "metadataSync",
      "pipelineRegister",
      "contractUndeploy",
      "targetUnlock",
      "auditCheck",
      "targetLock",
      "contractPreScript",
      "contractCreateStageDataset",
      "contractCreateArchiveDataset",
      "contractCreateListDataset",
      "contractCreateDimDataset",
      "contractCreateFactDataset",
      "contractCreateDatasetFks",
      "contractDeployEtl",
      "contractDeployRoutine",
      "contractPostScript",
      "targetUnlock",
      "syncDate",
      "deployDate"
    ])
    expect(body.stderr).toEqual([])

    await app.close()
  })
})

import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AgentHost } from "@mia/agent"
import { createPublishedSyncDefinitionRegistry, type EntityDefinition } from "@mia/sync"
import type { CurrentSession } from "../src/features/auth/context.js"

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
    mssql: {
      databases: new Map(),
      defaultConnection: { value: "DEV" }
    },
    sync: {
      events: { sink: () => {} },
      runs: { sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null } },
      governance: { freezeWindowsReader: () => [] },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: root,
        publishedDefinitions: createPublishedSyncDefinitionRegistry()
      }
    }
  } as unknown as AgentHost
}

async function buildApp(session: CurrentSession): Promise<{ app: FastifyInstance; host: AgentHost }> {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  const { registerSyncRoutes } = await import("../src/features/sync/routes.js")
  const { seedUser, seedSession } = await import("./_fk-helpers.js")

  _setDb(testDb)
  _migrate(testDb)

  const host = createHost(projectRoot)
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
    seedUser(testDb, session.upn, {
      displayName: session.displayName,
      isAdmin: session.isAdmin
    })
    seedSession(testDb, session.sid, session.upn)
  })
  registerSyncRoutes(app, projectRoot, host)
  await app.ready()
  return { app, host }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-sync-routes-data-"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-sync-routes-root-"))
  mkdirSync(join(projectRoot, "deploy", "sync", "artifacts"), { recursive: true })
  mkdirSync(join(projectRoot, "sync-definitions", "entities"), { recursive: true })
  mkdirSync(join(projectRoot, "sync-definitions", "published"), { recursive: true })
  writeFileSync(
    join(projectRoot, "deploy", "sync", "artifacts", "flow-templates.json"),
    readFileSync(new URL("../../../deploy/sync/artifacts/flow-templates.json", import.meta.url), "utf-8")
  )
  writeFileSync(
    join(projectRoot, "sync-definitions", "entities", "pipelineActivity.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "pipelineActivity",
        displayName: "Pipeline Activity",
        description: "Test definition",
        rootTable: "core.PipelineActivity",
        idColumn: "pipelineActivityId",
        labelColumn: null,
        selfJoinColumn: null,
        legacy: { pipelineId: null, entrySproc: null },
        governance: { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1 },
        strategy: { strategyId: "mymi-scd2", strategyVersion: "latest" },
        bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
        ownership: { team: "sync-platform", owner: null, reviewStatus: "reviewed", notes: ["test"] },
        metadata: {
          tables: [
            {
              name: "core.PipelineActivity",
              scopeColumn: "pipelineActivityId",
              predicate: "pipelineActivityId = {id}",
              source: "manual",
              verified: true,
              groundedByPipeline: false,
              enabledByDefault: true,
              userControllable: false
            }
          ],
          executionOrder: ["core.PipelineActivity"],
          reverseOrder: ["core.PipelineActivity"],
          discrepancies: []
        },
        executionFlow: {
          steps: [
            {
              id: "metadata-sync",
              phase: "metadata",
              kind: "metadataSync",
              title: "Metadata sync",
              description: "Apply metadata."
            },
            {
              id: "pipeline-register",
              phase: "post-metadata",
              kind: "pipelineRegister",
              title: "Pipeline register",
              description: "Register pipeline."
            }
          ]
        },
        provenance: { kind: "manual", sourceArtifact: "test", sourceVersion: "1" }
      },
      null,
      2
    )
  )
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("sync routes", () => {
  it("publishes DB-authored definitions and exposes them immediately via runtime definitions", async () => {
    const { app } = await buildApp(adminSession())
    const { saveEntityDefinition } = await import("../src/platform/persistence/db/index.js")

    const entityDefinition: EntityDefinition = {
      tenantId: "_default",
      id: "pipeline_activity",
      displayName: "Pipeline Activity",
      description: "Test definition",
      rootTable: "core.PipelineActivity",
      idColumn: "pipelineActivityId",
      labelColumn: null,
      selfJoinColumn: null,
      tables: [
        {
          name: "core.PipelineActivity",
          scope: { kind: "rootPk", column: "pipelineActivityId" },
          executionOrder: 0,
          scd2Override: null,
          verified: true,
          scopeColumn: "pipelineActivityId",
          source: "manual",
          groundedByPipeline: false,
          enabledByDefault: true,
          userControllable: false,
          archiveTable: "coreArchive.PipelineActivity",
          note: null,
          provenance: { kind: "manual" }
        }
      ],
      policies: { freezeWindowIds: [], riskMultiplier: 1 },
      scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
      lineageRefs: [],
      provenance: { kind: "manual" },
      legacyEntrySproc: null,
      reverseOrder: ["core.PipelineActivity"],
      discrepancies: [],
      version: 1,
      versionLabel: null,
      createdBy: "admin@example.com",
      reason: "seed",
      createdAt: new Date().toISOString(),
      retiredAt: null
    }
    saveEntityDefinition({
      tenantId: "_default",
      def: entityDefinition,
      actor: "admin@example.com",
      reason: "seed"
    })

    const publish = await app.inject({
      method: "POST",
      url: "/api/sync/definitions/publish"
    })

    expect(publish.statusCode).toBe(200)
    const publishBody = publish.json() as {
      definitionCount: number
      publishedBundlePath: string
    }
    expect(publishBody.definitionCount).toBe(1)
    expect(publishBody.publishedBundlePath).toBe("sync-definitions/published/definitions.bundle.json")

    const publishedBundle = JSON.parse(
      readFileSync(join(projectRoot, "sync-definitions", "published", "definitions.bundle.json"), "utf-8")
    ) as {
      definitions: Record<string, { id: string; publishedVersion: string }>
    }
    expect(publishedBundle.definitions.pipeline_activity?.id).toBe("pipeline_activity")
    expect(typeof publishedBundle.definitions.pipeline_activity?.publishedVersion).toBe("string")

    const definitions = await app.inject({
      method: "GET",
      url: "/api/sync/definitions"
    })
    expect(definitions.statusCode).toBe(200)
    const body = definitions.json() as Array<{ id: string; publishedVersion: string }>
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: "pipeline_activity" })
    expect(typeof body[0]?.publishedVersion).toBe("string")

    await app.close()
  })
})

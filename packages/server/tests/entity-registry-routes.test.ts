import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CurrentSession } from "../src/auth/context.js"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

async function buildApp(session: CurrentSession | null): Promise<FastifyInstance> {
  const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
  const { registerEntityRegistryRoutes } = await import("../src/api/entity-registry.js")
  const { seedUser, seedSession } = await import("./_fk-helpers.js")

  _setDb(testDb)
  _migrate(testDb)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    if (!session) return
    ;(req as unknown as { session: CurrentSession }).session = session
    seedUser(testDb, session.upn, {
      displayName: session.displayName,
      isAdmin: session.isAdmin,
    })
    seedSession(testDb, session.sid, session.upn)
  })
  registerEntityRegistryRoutes(app, projectRoot)
  await app.ready()
  return app
}

function adminSession(): CurrentSession {
  return {
    sid: "sid-admin",
    displayName: "Admin User",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest",
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-entity-routes-data-"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-entity-routes-root-"))
  mkdirSync(join(projectRoot, "sync-definitions", "entities"), { recursive: true })
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

describe("entity-registry sync definition routes", () => {
  it("exports a repo-definition draft directly from the stored entity definition", async () => {
    const app = await buildApp(adminSession())
    const { saveEntityDefinition } = await import("../src/adapters/persistence/db/entity-defs.js")
    saveEntityDefinition({
      actor: "admin@example.com",
      reason: "seed",
      def: {
        id: "contract",
        tenantId: "_default",
        displayName: "Contract",
        description: "Contract draft",
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
            source: "fk+pipeline",
            groundedByPipeline: true,
            enabledByDefault: true,
            userControllable: false,
          },
          {
            name: "core.Step",
            scope: {
              kind: "fkPath",
              through: [{ table: "core.Pipeline", fromColumn: "pipelineId", toColumn: "pipelineId" }],
            },
            executionOrder: 1,
            scd2Override: null,
            verified: false,
            archiveTable: null,
            note: "Needs review",
            provenance: { kind: "manual" },
            scopeColumn: null,
            source: "fk-only",
            groundedByPipeline: false,
            enabledByDefault: false,
            userControllable: true,
          },
        ],
        policies: { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1 },
        scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
        lineageRefs: [],
        provenance: { kind: "legacy-migration", legacyPipelineId: 788 },
        legacyEntrySproc: "core.uspSyncCoreObjectsTran",
        reverseOrder: ["core.Step", "core.Contract"],
        discrepancies: ["verify step scope"],
        version: 1,
        versionLabel: null,
        createdBy: "admin@example.com",
        reason: "seed",
        createdAt: "2026-05-28T00:00:00.000Z",
        retiredAt: null,
      },
    })

    const response = await app.inject({
      method: "POST",
      url: "/api/entity-registry/entities/contract/export-sync-definition",
      payload: { serviceProfileRef: "etl", environmentPolicyRef: "prod-safe" },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      entityId: string
      outputPath: string
      flowPreset: string
      warnings: string[]
      draft: {
        bindings: { serviceProfileRef: string; environmentPolicyRef: string }
        executionFlow: { steps: Array<{ kind: string }> }
        metadata: { tables: Array<{ name: string; predicate: string }> }
      }
      status: null
    }
    expect(body.entityId).toBe("contract")
    expect(body.outputPath).toBe("sync-definitions/entities/contract.json")
    expect(body.flowPreset).toBe("contract")
    expect(body.draft.bindings).toEqual({ serviceProfileRef: "etl", environmentPolicyRef: "prod-safe" })
    expect(body.draft.executionFlow.steps.map((step) => step.kind)).toEqual([
      "auditCheck",
      "targetLock",
      "metadataSync",
      "pipelineRegister",
      "contractDeploy",
    ])
    expect(body.draft.metadata.tables.find((table) => table.name === "core.Step")?.predicate).toContain("EXISTS (SELECT 1")
    expect(body.warnings.some((warning) => warning.includes("legacy-migration provenance"))).toBe(true)
    expect(body.warnings.some((warning) => warning.includes("still marked unverified"))).toBe(true)

    await app.close()
  })

  it("reports authoring status for repo definitions and remaining compatibility layers", async () => {
    writeFileSync(join(projectRoot, "sync-definitions", "entities", "contract.json"), JSON.stringify({
      schemaVersion: 1,
      id: "contract",
      displayName: "Contract",
      description: "Contract definition",
      rootTable: "core.Contract",
      idColumn: "contractId",
      labelColumn: "name",
      selfJoinColumn: null,
      legacy: { pipelineId: 788, entrySproc: "core.uspSyncCoreObjectsTran" },
      governance: { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1 },
      strategy: { strategyId: "mymi-scd2", strategyVersion: "latest" },
      bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
      ownership: {
        team: "sync-platform",
        owner: null,
        reviewStatus: "legacy-review-required",
        notes: ["Needs deliberate review."],
      },
      metadata: {
        tables: [{
          name: "core.Contract",
          scopeColumn: "contractId",
          predicate: "contractId = {id}",
          source: "fk+pipeline",
          verified: false,
          groundedByPipeline: true,
          enabledByDefault: true,
          userControllable: false,
        }],
        executionOrder: ["core.Contract"],
        reverseOrder: ["core.Contract"],
        discrepancies: [],
      },
      executionFlow: {
        steps: [{ id: "metadata-sync", phase: "metadata", kind: "metadataSync", title: "Metadata sync", description: "Apply metadata" }],
      },
      provenance: {
        kind: "legacy-migration",
        sourceArtifact: "deploy/mssql/sync-recipes.json",
        sourceVersion: "2026-05-10T11:19:07.694Z",
      },
    }, null, 2))

    const app = await buildApp(adminSession())
    const response = await app.inject({ method: "GET", url: "/api/entity-registry/sync-definition-status" })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      draftExport: { route: string; supportedFlowPresets: string[] }
      compatibilityLayers: Array<{ id: string; runtimeAuthority: boolean }>
      definitions: Array<{ id: string; provenanceKind: string; reviewStatus: string; ownershipTeam: string; unverifiedTableCount: number; cleanupWarnings: string[] }>
    }
    expect(body.draftExport.route).toBe("/api/entity-registry/entities/:id/export-sync-definition")
    expect(body.draftExport.supportedFlowPresets).toContain("metadata-only")
    expect(body.compatibilityLayers.map((layer) => layer.id)).toEqual([
      "compatibility-recipe-export",
      "entity-registry-projector",
      "entity-registry-yaml-bootstrap",
    ])
    expect(body.compatibilityLayers.every((layer) => layer.runtimeAuthority === false)).toBe(true)
    expect(body.definitions).toHaveLength(1)
    expect(body.definitions[0]?.id).toBe("contract")
    expect(body.definitions[0]?.provenanceKind).toBe("legacy-migration")
    expect(body.definitions[0]?.reviewStatus).toBe("legacy-review-required")
    expect(body.definitions[0]?.ownershipTeam).toBe("sync-platform")
    expect(body.definitions[0]?.unverifiedTableCount).toBe(1)
    expect(body.definitions[0]?.cleanupWarnings.some((warning) => warning.includes("bootstrapped from legacy data"))).toBe(true)

    await app.close()
  })
})
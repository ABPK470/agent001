/**
 * Shared fixture for catalog operator workflow integration tests.
 */

import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { CurrentSession } from "../../src/api/auth/index.js"
import * as db from "../../src/infra/persistence/db/index.js"

export const TENANT = "_default"

export type CatalogOperatorFixture = {
  testDb: Database.Database
  dataDir: string
  projectRoot: string
  adminSession: CurrentSession
}

const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

export function seedRepoArtifacts(root: string): void {
  const repoDeploySync = resolve(fileURLToPath(new URL("../../../../deploy/sync", import.meta.url)))
  const targetDeploySync = resolve(root, "deploy/sync")
  mkdirSync(join(targetDeploySync, "artifacts", "entities"), { recursive: true })

  const entitiesDir = join(repoDeploySync, "artifacts", "entities")
  if (existsSync(entitiesDir)) {
    for (const name of readdirSync(entitiesDir).filter((file) => file.endsWith(".json"))) {
      copyFileSync(join(entitiesDir, name), join(targetDeploySync, "artifacts", "entities", name))
    }
  }

  for (const name of ["sync-metadata.json", "strategies.json", "flow-templates.json"]) {
    const source = join(repoDeploySync, "artifacts", name)
    if (existsSync(source)) {
      copyFileSync(source, join(targetDeploySync, "artifacts", name))
    }
  }

  const envSource = join(repoDeploySync, "sync-environments.json")
  if (existsSync(envSource)) {
    copyFileSync(envSource, join(targetDeploySync, "sync-environments.json"))
  }
}

export async function setupCatalogOperatorFixture(): Promise<CatalogOperatorFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "catalog-operator-"))
  process.env["MIA_DATA_DIR"] = dataDir
  const testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  const projectRoot = mkdtempSync(join(tmpdir(), "catalog-operator-root-"))
  seedRepoArtifacts(projectRoot)

  const { seedEntityRegistryIfEmpty } = await import(
    "../../src/api/sync/service/seed-entity-registry.js"
  )
  const { seedSyncMetadataIfEmpty } = await import(
    "../../src/api/sync/service/seed-sync-metadata.js"
  )
  const { ensureSyncDefinitionConfigs } = await import(
    "../../src/api/sync/service/definitions.js"
  )
  seedEntityRegistryIfEmpty(projectRoot)
  seedSyncMetadataIfEmpty(projectRoot)
  ensureSyncDefinitionConfigs(projectRoot)

  const adminSession: CurrentSession = {
    sid: "sid-catalog-operator",
    displayName: "Catalog Operator",
    upn: "operator@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest",
  }

  return { testDb, dataDir, projectRoot, adminSession }
}

export function teardownCatalogOperatorFixture(fixture: CatalogOperatorFixture): void {
  if (fixture.projectRoot) rmSync(fixture.projectRoot, { recursive: true, force: true })
  if (fixture.dataDir) rmSync(fixture.dataDir, { recursive: true, force: true })
  process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
}

export async function buildEntityRegistryApp(
  fixture: CatalogOperatorFixture,
): Promise<FastifyInstance> {
  const { registerEntityRegistryRoutes } = await import(
    "../../src/api/sync/handlers/definitions-routes.js"
  )
  const { seedUser, seedSession } = await import("../_fk-helpers.js")

  seedUser(fixture.testDb, fixture.adminSession.upn, {
    displayName: fixture.adminSession.displayName,
    isAdmin: fixture.adminSession.isAdmin,
  })
  seedSession(fixture.testDb, fixture.adminSession.sid, fixture.adminSession.upn)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = fixture.adminSession
  })
  registerEntityRegistryRoutes(app, fixture.projectRoot)
  await app.ready()
  return app
}

export async function buildSyncMetadataApp(
  fixture: CatalogOperatorFixture,
): Promise<FastifyInstance> {
  const { registerSyncMetadataRoutes } = await import(
    "../../src/api/sync/handlers/sync-metadata-routes.js"
  )
  const { seedUser, seedSession } = await import("../_fk-helpers.js")

  seedUser(fixture.testDb, fixture.adminSession.upn, {
    displayName: fixture.adminSession.displayName,
    isAdmin: fixture.adminSession.isAdmin,
  })
  seedSession(fixture.testDb, fixture.adminSession.sid, fixture.adminSession.upn)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = fixture.adminSession
  })
  registerSyncMetadataRoutes(app)
  await app.ready()
  return app
}

export function listPresetStepKinds(tenantId = TENANT): string[] {
  const kinds: string[] = []
  for (const preset of db.listSyncRunPresets(tenantId)) {
    for (const step of db.parsePresetSteps(preset.steps_json)) {
      kinds.push(step.kind)
    }
  }
  return kinds
}

export function contentFlowStepsFromDb(tenantId = TENANT) {
  const preset = db.getSyncRunPreset(tenantId, "content")
  if (!preset) throw new Error("content flow preset missing from seeded catalog")
  return db.parsePresetSteps(preset.steps_json)
}

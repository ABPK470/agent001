/**
 * Publish parity — shipped deploy artifacts are ground truth for bundled entities.
 *
 * Publish must project identical predicates from artifact-seeded SQLite.
 * Also guards the checked-in definitions.bundle.json when REPUBLISH_BUNDLE=1.
 */

import Database from "better-sqlite3"
import type { AuthoredSyncDefinition } from "@mia/shared-types"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { publishSyncDefinitionsFromDb } from "../src/api/sync/service/definitions.js"
import { seedEntityRegistryIfEmpty } from "../src/api/sync/service/seed-entity-registry.js"
import { entityDefinitionFromAuthoredSync, projectTablePredicate } from "@mia/sync"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const REPO_ARTIFACTS_DIR = join(REPO_ROOT, "deploy/sync/artifacts/entities")
const REPO_BUNDLE_PATH = join(REPO_ROOT, "sync-definitions/published/definitions.bundle.json")

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function copyRepoDeployArtifacts(targetRoot: string): void {
  const targetDir = join(targetRoot, "deploy/sync/artifacts/entities")
  mkdirSync(targetDir, { recursive: true })
  for (const file of readdirSync(REPO_ARTIFACTS_DIR).filter((name) => name.endsWith(".json"))) {
    copyFileSync(join(REPO_ARTIFACTS_DIR, file), join(targetDir, file))
  }
  for (const name of ["sync-metadata.json", "strategies.json", "flow-templates.json"]) {
    const source = join(REPO_ROOT, "deploy/sync/artifacts", name)
    if (existsSync(source)) {
      mkdirSync(join(targetRoot, "deploy/sync/artifacts"), { recursive: true })
      copyFileSync(source, join(targetRoot, "deploy/sync/artifacts", name))
    }
  }
  const envSource = join(REPO_ROOT, "deploy/sync/sync-environments.json")
  if (existsSync(envSource)) {
    mkdirSync(join(targetRoot, "deploy/sync"), { recursive: true })
    copyFileSync(envSource, join(targetRoot, "deploy/sync/sync-environments.json"))
  }
}

function loadArtifact(entityId: string): AuthoredSyncDefinition {
  return JSON.parse(
    readFileSync(join(REPO_ARTIFACTS_DIR, `${entityId}.json`), "utf-8"),
  ) as AuthoredSyncDefinition
}

function expectedPredicateMap(entityId: string): Map<string, string> {
  const authored = loadArtifact(entityId)
  const entity = entityDefinitionFromAuthoredSync(authored, "_default")
  return new Map(entity.tables.map((table) => [table.name, projectTablePredicate(entity, table)]))
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "publish-parity-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  projectRoot = mkdtempSync(join(tmpdir(), "publish-parity-root-"))
  copyRepoDeployArtifacts(projectRoot)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
  process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function seedAndPublish(): Promise<Record<string, unknown>> {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  const { seedSyncMetadataIfEmpty } = await import(
    "../src/api/sync/service/seed-sync-metadata.js"
  )

  _setDb(testDb)
  _migrate(testDb)
  seedEntityRegistryIfEmpty(projectRoot)
  seedSyncMetadataIfEmpty(projectRoot)
  publishSyncDefinitionsFromDb(projectRoot)

  const { loadPublishedBundleFromDb } = await import("../src/infra/persistence/db/index.js")
  const bundle = loadPublishedBundleFromDb()
  if (!bundle) throw new Error("expected SyncDefinitions in SQLite after publish")
  return bundle as unknown as Record<string, unknown>
}

describe("deploy artifact publish parity", () => {
  for (const entityId of [
    "content",
    "contract",
    "dataset",
    "rule",
    "gateMetadata",
    "pipelineActivity",
  ]) {
    it(`publish preserves every table predicate for ${entityId}`, async () => {
      const bundle = (await seedAndPublish()) as {
        definitions: Record<string, { metadata: { tables: Array<{ name: string; predicate: string; note?: string }> } }>
      }
      const expected = expectedPredicateMap(entityId)
      const published = bundle.definitions[entityId]
      expect(published, `missing published definition ${entityId}`).toBeTruthy()

      for (const [tableName, predicate] of expected) {
        const row = published.metadata.tables.find((table) => table.name === tableName)
        expect(row, `${entityId} missing table ${tableName}`).toBeTruthy()
        expect(row!.predicate, `${entityId}.${tableName}`).toBe(predicate)
        expect(row!.note ?? "").not.toMatch(/Predicate unresolved from legacy pipeline variable/)
      }
    })
  }

  it("content lookup tables use EXISTS correlation from ground-truth artifacts", async () => {
    const bundle = (await seedAndPublish()) as {
      definitions: {
        content: { metadata: { tables: Array<{ name: string; predicate: string }> } }
      }
    }
    const contentType = bundle.definitions.content.metadata.tables.find(
      (table) => table.name === "gate.ContentType",
    )
    const contentLinkType = bundle.definitions.content.metadata.tables.find(
      (table) => table.name === "gate.ContentLinkType",
    )

    expect(contentType?.predicate).toContain("EXISTS")
    expect(contentType?.predicate).toContain("FROM gate.Content WHERE contentId = {id}")
    expect(contentLinkType?.predicate).toContain("EXISTS")
    expect(contentLinkType?.predicate).toContain("FROM gate.ContentLink WHERE contentId = {id}")
  })

  it("rule root scopes through fRule tree, not bare ruleId", async () => {
    const bundle = (await seedAndPublish()) as {
      definitions: {
        rule: { metadata: { tables: Array<{ name: string; predicate: string }> } }
      }
    }
    const rootRule = bundle.definitions.rule.metadata.tables.find((table) => table.name === "core.Rule")
    expect(rootRule?.predicate).toContain("[core].[fRule]({id})")
    expect(rootRule?.predicate).not.toBe("ruleId IN ({ids})")
  })

  it("repairs degraded SQLite entities from deploy artifacts on boot", async () => {
    const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
    const { repairBundledEntityDefinitionsFromArtifacts } = await import(
      "../src/api/sync/service/seed-entity-registry.js"
    )

    _setDb(testDb)
    _migrate(testDb)
    seedEntityRegistryIfEmpty(projectRoot)

    const pointer = testDb
      .prepare(`SELECT current_version FROM entity_defs WHERE tenant_id = '_default' AND id = 'content'`)
      .get() as { current_version: number }
    const row = testDb
      .prepare(
        `SELECT body_json FROM entity_def_versions WHERE tenant_id = '_default' AND id = 'content' AND version = ?`,
      )
      .get(pointer.current_version) as { body_json: string }
    const body = JSON.parse(row.body_json) as {
      tables: Array<{ name: string; scope: { kind: string; predicate?: string }; note?: string | null }>
    }
    const contentType = body.tables.find((table) => table.name === "gate.ContentType")
    if (contentType?.scope.kind === "sql") {
      contentType.scope.predicate =
        "[contentTypeId] IN (SELECT DISTINCT [contentTypeId] FROM [gate].[Content] WHERE [contentId] IN ({ids}))"
      contentType.note =
        "Predicate unresolved from legacy pipeline variable @contentTypeIds. Verify against core.uspSyncContentObjectsTran body."
    }
    testDb.exec(`DROP TRIGGER IF EXISTS entity_def_versions_no_update`)
    testDb
      .prepare(
        `UPDATE entity_def_versions SET body_json = ? WHERE tenant_id = '_default' AND id = 'content' AND version = ?`,
      )
      .run(JSON.stringify(body), pointer.current_version)
    testDb.exec(`
      CREATE TRIGGER IF NOT EXISTS entity_def_versions_no_update
      BEFORE UPDATE ON entity_def_versions
      BEGIN SELECT RAISE(ABORT, 'entity_def_versions is append-only'); END;
    `)

    const repaired = repairBundledEntityDefinitionsFromArtifacts(projectRoot)
    expect(repaired).toContain("content")

    const restored = (await import("../src/infra/persistence/db/index.js")).getEntityDefinition(
      "_default",
      "content",
    )
    const restoredType = restored?.tables.find((table) => table.name === "gate.ContentType")
    expect(restoredType?.scope.kind).toBe("sql")
    if (restoredType?.scope.kind === "sql") {
      expect(restoredType.scope.predicate).toContain("EXISTS")
      expect(restoredType.note ?? "").not.toMatch(/Predicate unresolved from legacy pipeline variable/)
    }
  })

  it("SQLite SyncDefinitions match artifact publish parity", async () => {
    const bundle = (await seedAndPublish()) as {
      definitions: Record<string, { metadata: { tables: Array<{ name: string; predicate: string }> } }>
    }

    for (const entityId of ["content", "contract", "dataset", "rule"]) {
      const expected = expectedPredicateMap(entityId)
      const published = bundle.definitions[entityId]
      expect(published, `published SyncDefinition missing ${entityId}`).toBeTruthy()
      for (const [tableName, predicate] of expected) {
        const row = published.metadata.tables.find((table) => table.name === tableName)
        expect(row?.predicate, `published ${entityId}.${tableName}`).toBe(predicate)
      }
    }

    // Optional: refresh legacy fixture file for smoke tests (not runtime authority).
    if (process.env["REPUBLISH_BUNDLE"] === "1") {
      mkdirSync(join(REPO_ROOT, "sync-definitions/published"), { recursive: true })
      writeFileSync(REPO_BUNDLE_PATH, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8")
    }
  })
})

/**
 * Boot identity load — seeded EntityDefinitions + configs must match G2 golden.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { EntityDefinition } from "@mia/sync"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const G2_PATH = join(REPO_ROOT, "packages/sync/src/test-support/__goldens__/legacy-refresh/g2-logical.json")
const G3_PATH = join(REPO_ROOT, "packages/sync/src/test-support/__goldens__/legacy-refresh/g3-published.json")
/** Must match packages/sync LEGACY_REFRESH_SEED_CREATED_AT / materialize script. */
const SEED_CREATED_AT = "2026-01-01T00:00:00.000Z"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function copyNativeSeeds(targetRoot: string): void {
  const srcArtifacts = join(REPO_ROOT, "deploy/sync/artifacts")
  const dstArtifacts = join(targetRoot, "deploy/sync/artifacts")
  mkdirSync(join(dstArtifacts, "entities"), { recursive: true })
  for (const file of readdirSync(join(srcArtifacts, "entities")).filter((n) => n.endsWith(".json"))) {
    copyFileSync(join(srcArtifacts, "entities", file), join(dstArtifacts, "entities", file))
  }
  for (const name of [
    "sync-metadata.json",
    "strategies.json",
    "flow-templates.json",
    "sync-definition-configs.json",
  ]) {
    const source = join(srcArtifacts, name)
    if (existsSync(source)) copyFileSync(source, join(dstArtifacts, name))
  }
  const envSource = join(REPO_ROOT, "deploy/sync/sync-environments.json")
  if (existsSync(envSource)) {
    mkdirSync(join(targetRoot, "deploy/sync"), { recursive: true })
    copyFileSync(envSource, join(targetRoot, "deploy/sync/sync-environments.json"))
  }
}

function normalizeEntity(entity: EntityDefinition): EntityDefinition {
  return {
    ...entity,
    createdAt: SEED_CREATED_AT,
    version: 1,
    versionLabel: "bundled-seed",
    createdBy: "system",
    reason: "bundled-seed",
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "native-seed-g2-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  projectRoot = mkdtempSync(join(tmpdir(), "native-seed-g2-root-"))
  copyNativeSeeds(projectRoot)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
  process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("native seed ≡ G2 logical catalog", () => {
  it("boot seed + ensure configs match frozen G2 entities and run bindings", async () => {
    const { _setDb, _migrate, listEntityDefinitions, listSyncDefinitionConfigs } = await import(
      "../src/infra/persistence/db/index.js"
    )
    const { seedEntityRegistryIfEmpty } = await import("../src/api/sync/service/seed-entity-registry.js")
    const { seedSyncMetadataIfEmpty } = await import("../src/api/sync/service/seed-sync-metadata.js")
    const { ensureSyncDefinitionConfigs } = await import("../src/api/sync/service/definitions.js")

    _setDb(testDb)
    _migrate(testDb)
    const seeded = seedEntityRegistryIfEmpty(projectRoot)
    expect(seeded.source).toBe("artifacts")
    expect(seeded.seeded).toBeGreaterThan(0)
    seedSyncMetadataIfEmpty(projectRoot)
    ensureSyncDefinitionConfigs(projectRoot)

    const g2 = JSON.parse(readFileSync(G2_PATH, "utf-8")) as {
      entities: Record<string, EntityDefinition>
      configs: Record<
        string,
        {
          entityId: string
          flowPreset: string
          serviceProfileRef: string
          environmentPolicyRef: string
          ownershipTeam: string
          ownershipOwner: string | null
          reviewStatus: string
          ownershipNotes: string[]
        }
      >
    }

    const entities = listEntityDefinitions("_default")
    expect(entities.map((e) => e.id).sort()).toEqual(Object.keys(g2.entities).sort())

    for (const entity of entities) {
      const expected = g2.entities[entity.id]!
      expect(normalizeEntity(entity)).toEqual(normalizeEntity(expected))
    }

    const configs = listSyncDefinitionConfigs("_default")
    expect(configs.map((c) => c.entity_id).sort()).toEqual(Object.keys(g2.configs).sort())
    for (const row of configs) {
      const expected = g2.configs[row.entity_id]!
      expect(row.flow_preset).toBe(expected.flowPreset)
      expect(row.service_profile_ref).toBe(expected.serviceProfileRef)
      expect(row.environment_policy_ref).toBe(expected.environmentPolicyRef)
      expect(row.ownership_team).toBe(expected.ownershipTeam)
      expect(row.ownership_owner).toBe(expected.ownershipOwner)
      expect(row.review_status).toBe(expected.reviewStatus)
      expect(JSON.parse(row.ownership_notes_json)).toEqual(expected.ownershipNotes)
    }
  })

  it("Publish from native seeds matches frozen G3 process JSON (DB dialect)", async () => {
    const { _setDb, _migrate, loadPublishedBundleFromDb } = await import(
      "../src/infra/persistence/db/index.js"
    )
    const { seedEntityRegistryIfEmpty } = await import("../src/api/sync/service/seed-entity-registry.js")
    const { seedSyncMetadataIfEmpty } = await import("../src/api/sync/service/seed-sync-metadata.js")
    const { publishSyncDefinitionsFromDb } = await import("../src/api/sync/service/definitions.js")

    _setDb(testDb)
    _migrate(testDb)
    seedEntityRegistryIfEmpty(projectRoot)
    seedSyncMetadataIfEmpty(projectRoot)
    publishSyncDefinitionsFromDb(projectRoot)

    const bundle = loadPublishedBundleFromDb()
    expect(bundle).toBeTruthy()

    const g3 = JSON.parse(readFileSync(G3_PATH, "utf-8")) as {
      definitions: Record<string, Record<string, unknown>>
    }

    for (const [id, expected] of Object.entries(g3.definitions)) {
      const published = bundle!.definitions[id] as Record<string, unknown> | null
      expect(published, `missing published ${id}`).toBeTruthy()
      const { publishedAt: _a, publishedVersion: _v, ...rest } = published!
      // File-catalog G3 keeps step.phase + catalog.phases; DB authoring catalog strips phases.
      expect(normalizePublishedDbDialect(rest)).toEqual(normalizePublishedDbDialect(expected))
    }
  })
})

/** Align file-catalog G3 with publishSyncDefinitionsFromDb dialect. */
function normalizePublishedDbDialect(def: Record<string, unknown>): Record<string, unknown> {
  const executionFlow = def["executionFlow"] as {
    steps: Array<Record<string, unknown>>
    catalog?: { phases?: unknown; kinds?: unknown; customValueSources?: unknown }
  }
  const steps = executionFlow.steps.map((step) => {
    const { phase: _phase, ...rest } = step
    return rest
  })
  const catalog = executionFlow.catalog
    ? {
        phases: {},
        kinds: executionFlow.catalog.kinds ?? {},
        customValueSources: executionFlow.catalog.customValueSources ?? {},
      }
    : executionFlow.catalog
  return {
    ...def,
    executionFlow: { steps, catalog },
  }
}

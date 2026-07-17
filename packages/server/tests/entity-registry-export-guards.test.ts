/**
 * Export guards — every export path must emit import-safe JSON only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"
import {
  entityDefinitionFromAuthoredSync,
  isDegradedLegacyFallbackPredicate,
  looksIncompleteScopePredicate,
} from "@mia/sync"

import {
  EntityExportValidationError,
} from "../src/api/sync/application/assert-entity-export.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/application/export-deploy-artifacts.js"
import { exportDeployGitZipBuffer } from "../src/api/platform/application/export-deploy-git-artifacts.js"
import { parseDeployGitZipBuffer } from "../src/api/platform/application/import-deploy-git-artifacts.js"
import { validateDeployCatalogSnapshot } from "../src/api/platform/application/import-deploy-artifacts.js"
import {
  entityToAuthoredSyncDefinition,
  formatAuthoredSyncJson,
  syncConfigInputFromDb,
} from "../src/api/sync/domain/authored-sync-document.js"
import { formatEntityJson, parseEntitiesJson } from "../src/api/sync/domain/entity-yaml.js"
import { loadAuthoringFlowCatalog } from "../src/api/sync/application/definitions.js"
import {
  importAuthoredSyncFromText,
  importOneAuthoredSync,
} from "../src/api/sync/application/import-authored-sync.js"
import * as db from "../src/infra/persistence/db/index.js"
import {
  buildEntityRegistryApp,
  setupCatalogOperatorFixture,
  teardownCatalogOperatorFixture,
  TENANT,
  type CatalogOperatorFixture,
} from "./helpers/catalog-operator-fixture.js"

const CORE_ENTITIES = [
  "content",
  "contract",
  "dataset",
  "rule",
  "gateMetadata",
  "pipelineActivity",
] as const

let fixture: CatalogOperatorFixture

function corruptContentContentTypePredicate(): void {
  const pointer = fixture.testDb
    .prepare(`SELECT current_version FROM entity_defs WHERE tenant_id = ? AND id = 'content'`)
    .get(TENANT) as { current_version: number }
  const row = fixture.testDb
    .prepare(
      `SELECT body_json FROM entity_def_versions WHERE tenant_id = ? AND id = 'content' AND version = ?`,
    )
    .get(TENANT, pointer.current_version) as { body_json: string }
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
  fixture.testDb.exec(`DROP TRIGGER IF EXISTS entity_def_versions_no_update`)
  fixture.testDb
    .prepare(
      `UPDATE entity_def_versions SET body_json = ? WHERE tenant_id = ? AND id = 'content' AND version = ?`,
    )
    .run(JSON.stringify(body), TENANT, pointer.current_version)
  fixture.testDb.exec(`
    CREATE TRIGGER IF NOT EXISTS entity_def_versions_no_update
    BEFORE UPDATE ON entity_def_versions
    BEGIN SELECT RAISE(ABORT, 'entity_def_versions is append-only'); END;
  `)
}

function assertAuthoredImportable(authored: AuthoredSyncDefinition): void {
  for (const table of authored.metadata.tables) {
    expect(looksIncompleteScopePredicate(table.predicate)).toBe(false)
    expect(isDegradedLegacyFallbackPredicate(table.predicate)).toBe(false)
    expect(table.note ?? "").not.toMatch(/Predicate unresolved from legacy pipeline variable/)
  }
  const reimported = entityDefinitionFromAuthoredSync(authored, TENANT)
  const flowTemplateCatalog = loadAuthoringFlowCatalog(fixture.projectRoot, TENANT)
  const result = importOneAuthoredSync({
    authored,
    tenantId: TENANT,
    actor: "export-guard",
    reason: "round-trip",
    projectRoot: fixture.projectRoot,
    dryRun: true,
    flowTemplateCatalog,
  })
  expect(result.error, `${authored.id} dry-run import`).toBeUndefined()
  expect(reimported.tables.length).toBe(authored.metadata.tables.length)
}

beforeEach(async () => {
  fixture = await setupCatalogOperatorFixture()
})

afterEach(() => {
  teardownCatalogOperatorFixture(fixture)
})

describe("entity export guards — per-entity paths", () => {
  for (const entityId of CORE_ENTITIES) {
    it(`deploy artifact export for ${entityId} is import-safe`, () => {
      const entity = db.getEntityDefinition(TENANT, entityId)
      const config = db.getSyncDefinitionConfig(TENANT, entityId)
      expect(entity).toBeTruthy()
      expect(config).toBeTruthy()

      const catalog = loadAuthoringFlowCatalog(fixture.projectRoot, TENANT)
      const authored = entityToAuthoredSyncDefinition(
        entity!,
        catalog,
        syncConfigInputFromDb(config!),
      )
      assertAuthoredImportable(authored)

      const applied = importAuthoredSyncFromText({
        tenantId: TENANT,
        actor: "export-guard",
        reason: `${entityId}-round-trip`,
        content: formatAuthoredSyncJson(authored),
        projectRoot: fixture.projectRoot,
        dryRun: true,
      })
      expect(applied.ok).toBe(true)
    })

    it(`registry JSON export for ${entityId} is import-safe`, () => {
      const entity = db.getEntityDefinition(TENANT, entityId)
      const config = db.getSyncDefinitionConfig(TENANT, entityId)
      expect(entity).toBeTruthy()

      const json = formatEntityJson(entity!, {
        template: config!.flow_preset,
        service: config!.service_profile_ref,
        environment: config!.environment_policy_ref,
      })
      const parsed = parseEntitiesJson(json)
      expect(parsed[0]?.ok).toBe(true)
      expect(parsed[0]?.def?.tables.length).toBe(entity!.tables.length)
    })
  }
})

describe("entity export guards — bulk paths", () => {
  it("catalog snapshot export validates and round-trips through import preview", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(true)
    expect(preview.errors).toEqual([])
  })

  it("deploy git zip export contains only import-safe authored artifacts", () => {
    const { buffer } = exportDeployGitZipBuffer(fixture.projectRoot, { tenantId: TENANT })
    expect(buffer.length).toBeGreaterThan(0)

    const bundle = parseDeployGitZipBuffer(buffer)
    for (const entityId of CORE_ENTITIES) {
      const authored = bundle.entities.find((entity) => entity.id === entityId)
      expect(authored, `missing ${entityId} in deploy zip export`).toBeTruthy()
      assertAuthoredImportable(authored!)
    }
  })
})

describe("entity export guards — corrupt SQLite blocked at export", () => {
  it("per-entity deploy artifact export fails when SQLite has degraded predicates", () => {
    corruptContentContentTypePredicate()
    const entity = db.getEntityDefinition(TENANT, "content")
    const config = db.getSyncDefinitionConfig(TENANT, "content")
    const catalog = loadAuthoringFlowCatalog(fixture.projectRoot, TENANT)

    expect(() =>
      entityToAuthoredSyncDefinition(entity!, catalog, syncConfigInputFromDb(config!)),
    ).toThrow(EntityExportValidationError)
  })

  it("catalog snapshot export fails when any entity is not exportable", () => {
    corruptContentContentTypePredicate()
    expect(() => buildDeployCatalogSnapshot({ tenantId: TENANT })).toThrow(
      EntityExportValidationError,
    )
  })

  it("HTTP artifact export returns 409 when entity is not exportable", async () => {
    corruptContentContentTypePredicate()
    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/entities/content/artifact.json",
    })
    expect(response.statusCode).toBe(409)
    const body = response.json() as { error: string; entityId: string }
    expect(body.entityId).toBe("content")
    expect(body.error).toContain("not exportable")
    await app.close()
  })
})

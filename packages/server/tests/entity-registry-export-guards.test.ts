/**
 * Export guards — Catalog export paths must emit import-safe JSON only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { EntityExportValidationError } from "../src/api/sync/service/assert-entity-export.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import { validateDeployCatalogSnapshot } from "../src/api/platform/service/import-deploy-artifacts.js"
import { formatEntityJson, parseEntitiesJson } from "../src/api/sync/types/entity-yaml.js"
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

beforeEach(async () => {
  fixture = await setupCatalogOperatorFixture()
})

afterEach(() => {
  teardownCatalogOperatorFixture(fixture)
})

describe("entity export guards — per-entity paths", () => {
  for (const entityId of CORE_ENTITIES) {
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
})

describe("entity export guards — corrupt SQLite blocked at export", () => {
  it("catalog snapshot export fails when any entity is not exportable", () => {
    corruptContentContentTypePredicate()
    expect(() => buildDeployCatalogSnapshot({ tenantId: TENANT })).toThrow(
      EntityExportValidationError,
    )
  })

  it("HTTP registry JSON export returns 409 when entity is not exportable", async () => {
    corruptContentContentTypePredicate()
    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/entities/content/registry.json",
    })
    expect(response.statusCode).toBe(409)
    const body = response.json() as { error: string; entityId: string }
    expect(body.entityId).toBe("content")
    expect(body.error).toContain("not exportable")
    await app.close()
  })
})

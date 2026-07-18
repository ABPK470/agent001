/**
 * Import corruption guards — Catalog paths must never persist degraded predicates
 * or unresolved review placeholders into SQLite.
 */

import type { AuthoredSyncDefinition } from "@mia/shared-types"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  entityDefinitionFromAuthoredSync,
  isDegradedLegacyFallbackPredicate,
  projectTablePredicate,
  resolveReviewPlaceholderPredicate,
  validateEntityDefinition,
} from "@mia/sync"

import {
  applyDeployCatalogSnapshot,
  validateDeployCatalogSnapshot,
} from "../src/api/platform/service/import-deploy-artifacts.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import { formatEntityJson } from "../src/api/sync/types/entity-yaml.js"
import * as db from "../src/infra/persistence/db/index.js"
import {
  setupCatalogOperatorFixture,
  teardownCatalogOperatorFixture,
  TENANT,
  type CatalogOperatorFixture,
} from "./helpers/catalog-operator-fixture.js"

const G1_AUTHORED_HISTORICAL = resolve(
  fileURLToPath(
    new URL(
      "../../../packages/sync/src/test-support/__goldens__/legacy-refresh/g1-authored-historical.json",
      import.meta.url,
    ),
  ),
)

let fixture: CatalogOperatorFixture

function loadHistoricalAuthored(entityId: string): AuthoredSyncDefinition {
  const g1 = JSON.parse(readFileSync(G1_AUTHORED_HISTORICAL, "utf-8")) as {
    entities: Record<string, AuthoredSyncDefinition>
  }
  const authored = g1.entities[entityId]
  if (!authored) throw new Error(`Missing historical Authored entity ${entityId}`)
  return authored
}

function contentTypePredicateFromDb(): string | null {
  const entity = db.getEntityDefinition(TENANT, "content")
  const table = entity?.tables.find((row) => row.name === "gate.ContentType")
  if (!table || table.scope.kind !== "sql") return null
  return table.scope.predicate
}

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

describe("resolveReviewPlaceholderPredicate — first principles", () => {
  it("returns null for review placeholders instead of guessing degraded IN lists", () => {
    const placeholder = "[contentTypeId] IN (/* review: derive from sproc */)"
    expect(
      resolveReviewPlaceholderPredicate(placeholder, {
        rootTable: "gate.Content",
        idColumn: "contentId",
        selfJoinColumn: "parentContentId",
        tableName: "gate.ContentType",
        scopeColumn: "contentTypeId",
      }),
    ).toBeNull()
  })
})

describe("A→B conversion guards (historical Authored → EntityDefinition)", () => {
  it("rejects unresolved review placeholders", () => {
    const seed = loadHistoricalAuthored("content")
    const poisoned: AuthoredSyncDefinition = {
      ...seed,
      metadata: {
        ...seed.metadata,
        tables: seed.metadata.tables.map((table) =>
          table.name === "gate.ContentType"
            ? {
                ...table,
                predicate: "[contentTypeId] IN (/* review: correlate via contentTypeId */)",
                verified: true,
                enabledByDefault: true,
              }
            : table,
        ),
      },
    }

    const def = entityDefinitionFromAuthoredSync(poisoned, TENANT)
    const validation = validateEntityDefinition(def)
    expect(validation.ok).toBe(false)
    expect(validation.errors.some((issue) => issue.code.includes("scope") || issue.message.includes("placeholder") || issue.message.includes("incomplete"))).toBe(true)
  })

  it("rejects explicit degraded IN-list predicates", () => {
    const seed = loadHistoricalAuthored("dataset")
    const poisoned: AuthoredSyncDefinition = {
      ...seed,
      metadata: {
        ...seed.metadata,
        tables: [
          {
            ...seed.metadata.tables[0]!,
            predicate:
              "[datasetId] IN (SELECT DISTINCT [datasetId] FROM [core].[Dataset] WHERE [datasetId] IN ({ids}))",
            verified: false,
            enabledByDefault: false,
          },
        ],
      },
    }

    const def = entityDefinitionFromAuthoredSync(poisoned, TENANT)
    const validation = validateEntityDefinition(def)
    expect(validation.ok).toBe(false)
    expect(validation.errors.some((issue) => issue.code === "scope_degraded_legacy")).toBe(true)
  })

  it("converts ground-truth content Authored with EXISTS predicates intact", () => {
    const seed = loadHistoricalAuthored("content")
    const entity = entityDefinitionFromAuthoredSync(seed, TENANT)
    expect(validateEntityDefinition(entity).ok).toBe(true)

    const expected = projectTablePredicate(
      entity,
      entity.tables.find((table) => table.name === "gate.ContentType")!,
    )
    expect(expected).toContain("EXISTS")
    expect(isDegradedLegacyFallbackPredicate(expected)).toBe(false)

    // Boot seed already loaded native content — projected predicate matches historical A→B.
    expect(contentTypePredicateFromDb()).toBe(expected)
  })
})

describe("catalog snapshot import guards", () => {
  it("restores corrupted content predicates when re-importing catalog snapshot", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })

    corruptContentContentTypePredicate()
    expect(contentTypePredicateFromDb()).toMatch(/IN\s*\(\s*SELECT\s+DISTINCT/i)

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)

    const predicate = contentTypePredicateFromDb()
    expect(predicate).toContain("EXISTS")
    expect(isDegradedLegacyFallbackPredicate(predicate!)).toBe(false)
  })

  it("bulk catalog re-import never introduces degraded IN-list predicates", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT, includeRetiredEntities: true })

    for (const row of db.listEntityDefinitions(TENANT)) {
      db.retireEntityDefinition(TENANT, row.id, "test")
    }

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)

    for (const entity of db.listEntityDefinitions(TENANT)) {
      for (const table of entity.tables) {
        if (table.scope.kind !== "sql") continue
        expect(
          isDegradedLegacyFallbackPredicate(table.scope.predicate),
          `${entity.id}.${table.name}`,
        ).toBe(false)
      }
    }
  })

  it("preview rejects entity registry rows with degraded predicates", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: TENANT })
    const entity = db.getEntityDefinition(TENANT, "content")
    expect(entity).toBeTruthy()

    const degraded = {
      ...entity!,
      tables: entity!.tables.map((table) =>
        table.name === "gate.ContentType" && table.scope.kind === "sql"
          ? {
              ...table,
              scope: {
                ...table.scope,
                predicate:
                  "[contentTypeId] IN (SELECT DISTINCT [contentTypeId] FROM [gate].[Content] WHERE [contentId] IN ({ids}))",
              },
              note: "Predicate unresolved from legacy pipeline variable @contentTypeIds.",
            }
          : table,
      ),
    }

    const config = db.getSyncDefinitionConfig(TENANT, "content")!
    snapshot.entityRegistry = {
      version: 1,
      _comment: "test",
      entities: [
        JSON.parse(
          formatEntityJson(degraded, {
            template: config.flow_preset,
            service: config.service_profile_ref,
            environment: config.environment_policy_ref,
          }),
        ) as Record<string, unknown>,
      ],
    }

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(false)
    expect(preview.errors.some((error) => error.includes("degraded"))).toBe(true)

    const before = contentTypePredicateFromDb()
    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(false)
    expect(contentTypePredicateFromDb()).toBe(before)
  })
})

/**
 * Import corruption guards — authored / bulk / catalog paths must never persist
 * degraded predicates or unresolved review placeholders into SQLite.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  entityDefinitionFromAuthoredSync,
  isDegradedLegacyFallbackPredicate,
  projectTablePredicate,
  resolveReviewPlaceholderPredicate,
} from "@mia/sync"

import {
  applyDeployCatalogSnapshot,
  validateDeployCatalogSnapshot,
} from "../src/api/platform/service/import-deploy-artifacts.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import {
  applyDeployGitBundle,
  parseDeployGitBundleFromDir,
} from "../src/api/platform/service/import-deploy-git-artifacts.js"
import { writeDeployGitExport } from "../src/api/platform/service/export-deploy-git-artifacts.js"
import { formatAuthoredSyncJson } from "../src/api/sync/types/authored-sync-document.js"
import { formatEntityJson } from "../src/api/sync/types/entity-yaml.js"
import {
  importAuthoredSyncFromText,
  importOneAuthoredSync,
} from "../src/api/sync/service/import-authored-sync.js"
import { loadAuthoringFlowCatalog } from "../src/api/sync/service/definitions.js"
import * as db from "../src/infra/persistence/db/index.js"
import {
  setupCatalogOperatorFixture,
  teardownCatalogOperatorFixture,
  TENANT,
  type CatalogOperatorFixture,
} from "./helpers/catalog-operator-fixture.js"

const REPO_ARTIFACTS = resolve(
  fileURLToPath(new URL("../../../deploy/sync/artifacts/entities", import.meta.url)),
)

let fixture: CatalogOperatorFixture

function loadArtifact(entityId: string): AuthoredSyncDefinition {
  return JSON.parse(
    readFileSync(join(REPO_ARTIFACTS, `${entityId}.json`), "utf-8"),
  ) as AuthoredSyncDefinition
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

describe("per-entity authored import guards", () => {
  it("rejects artifacts with unresolved review placeholders without writing SQLite", () => {
    const seed = loadArtifact("content")
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

    const before = contentTypePredicateFromDb()
    const result = importAuthoredSyncFromText({
      tenantId: TENANT,
      actor: "test",
      reason: "placeholder-guard",
      content: formatAuthoredSyncJson(poisoned),
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })

    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(contentTypePredicateFromDb()).toBe(before)
    expect(contentTypePredicateFromDb()).toContain("EXISTS")
  })

  it("rejects explicit degraded IN-list predicates from authored artifacts", () => {
    const seed = loadArtifact("dataset")
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

    const flowTemplateCatalog = loadAuthoringFlowCatalog(fixture.projectRoot, TENANT)
    const result = importOneAuthoredSync({
      authored: poisoned,
      tenantId: TENANT,
      actor: "test",
      reason: "degraded-guard",
      projectRoot: fixture.projectRoot,
      dryRun: false,
      flowTemplateCatalog,
    })

    expect(result.error).toBeTruthy()
    const validation =
      typeof result.error === "object" && result.error && "ok" in result.error
        ? result.error
        : null
    expect(validation?.ok).toBe(false)
    expect(
      validation?.errors.some((issue) => issue.code === "scope_degraded_legacy") ??
        String(result.error).includes("degraded"),
    ).toBe(true)
  })

  it("imports ground-truth content artifact with EXISTS predicates intact", () => {
    const seed = loadArtifact("content")
    importAuthoredSyncFromText({
      tenantId: TENANT,
      actor: "test",
      reason: "good-content",
      content: formatAuthoredSyncJson(seed),
      projectRoot: fixture.projectRoot,
      dryRun: false,
    })

    const predicate = contentTypePredicateFromDb()
    expect(predicate).toBeTruthy()
    expect(predicate).toContain("EXISTS")
    expect(isDegradedLegacyFallbackPredicate(predicate!)).toBe(false)

    const entity = entityDefinitionFromAuthoredSync(seed, TENANT)
    const expected = projectTablePredicate(
      entity,
      entity.tables.find((table) => table.name === "gate.ContentType")!,
    )
    expect(predicate).toBe(expected)
  })
})

describe("bulk deploy-git import guards", () => {
  it("restores corrupted content predicates when re-importing ground-truth deploy git bundle", () => {
    const parent = mkdtempSync(join(tmpdir(), "import-guard-export-"))
    try {
      const exported = writeDeployGitExport({
        outputParentDir: parent,
        projectRoot: fixture.projectRoot,
        tenantId: TENANT,
      })
      const bundle = parseDeployGitBundleFromDir(exported.folderPath)

      corruptContentContentTypePredicate()
      expect(contentTypePredicateFromDb()).toMatch(/IN\s*\(\s*SELECT\s+DISTINCT/i)

      const applied = applyDeployGitBundle({
        bundle,
        actor: "test",
        projectRoot: fixture.projectRoot,
        dryRun: false,
      })
      expect(applied.applied).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }

    const predicate = contentTypePredicateFromDb()
    expect(predicate).toContain("EXISTS")
    expect(isDegradedLegacyFallbackPredicate(predicate!)).toBe(false)
  })

  it("bulk import of shipped artifacts never introduces degraded IN-list predicates", () => {
    const parent = mkdtempSync(join(tmpdir(), "import-guard-bulk-"))
    try {
      const exported = writeDeployGitExport({
        outputParentDir: parent,
        projectRoot: fixture.projectRoot,
        tenantId: TENANT,
      })
      const bundle = parseDeployGitBundleFromDir(exported.folderPath)

      for (const row of db.listEntityDefinitions(TENANT)) {
        db.retireEntityDefinition(TENANT, row.id, "test")
      }

      applyDeployGitBundle({
        bundle,
        actor: "test",
        projectRoot: fixture.projectRoot,
        dryRun: false,
      })

      for (const entity of db.listEntityDefinitions(TENANT)) {
        for (const table of entity.tables) {
          if (table.scope.kind !== "sql") continue
          expect(
            isDegradedLegacyFallbackPredicate(table.scope.predicate),
            `${entity.id}.${table.name}`,
          ).toBe(false)
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe("catalog snapshot import guards", () => {
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

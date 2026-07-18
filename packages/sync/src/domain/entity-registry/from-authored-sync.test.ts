import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { entityDefinitionFromAuthoredSync } from "./from-authored-sync.js"
import { looksIncompleteScopePredicate, resolveReviewPlaceholderPredicate } from "./resolve-scope-predicate.js"
import { validateEntityDefinition } from "./validate.js"

const repoRoot = resolve(import.meta.dirname, "../../../../..")
const g1AuthoredPath = resolve(
  repoRoot,
  "packages/sync/src/test-support/__goldens__/legacy-refresh/g1-authored-historical.json",
)

function loadG1Authored(entityId: string): AuthoredSyncDefinition {
  const g1 = JSON.parse(readFileSync(g1AuthoredPath, "utf-8")) as {
    entities: Record<string, AuthoredSyncDefinition>
  }
  const authored = g1.entities[entityId]
  if (!authored) throw new Error(`Missing historical Authored entity ${entityId}`)
  return {
    ...authored,
    provenance: {
      ...authored.provenance,
      sourceVersion: "2026-01-01T00:00:00.000Z",
    },
  }
}

describe("resolveReviewPlaceholderPredicate", () => {
  it("does not guess degraded IN predicates from review placeholders", () => {
    const resolved = resolveReviewPlaceholderPredicate(
      "contentTypeId IN (/* review contentTypeIds */)",
      {
        rootTable: "gate.Content",
        idColumn: "contentId",
        selfJoinColumn: "parentContentId",
        tableName: "gate.ContentType",
        scopeColumn: "contentTypeId",
      },
    )
    expect(resolved).toBeNull()
  })
})

describe("entityDefinitionFromAuthoredSync", () => {
  it("imports G1 Authored artifacts as valid entity definitions", () => {
    const authored = loadG1Authored("contract")
    const entity = entityDefinitionFromAuthoredSync(authored)

    const validation = validateEntityDefinition(entity)
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(true)
    expect(entity.id).toBe("contract")
    expect(entity.tables.length).toBeGreaterThan(0)
    expect(entity.legacyEntrySproc).toBe("core.uspSyncCoreObjectsTran")
  })

  it("imports content with resolved lookup-table scopes", () => {
    const authored = loadG1Authored("content")
    const entity = entityDefinitionFromAuthoredSync(authored)
    const contentType = entity.tables.find((table) => table.name === "gate.ContentType")

    expect(contentType?.enabledByDefault).toBe(true)
    expect(contentType?.verified).toBe(true)
    if (contentType?.scope.kind === "sql") {
      expect(looksIncompleteScopePredicate(contentType.scope.predicate)).toBe(false)
    }

    const validation = validateEntityDefinition(entity)
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(true)
  })

  it("imports gateMetadata with unique 1-based execution orders", () => {
    const authored = loadG1Authored("gateMetadata")
    const entity = entityDefinitionFromAuthoredSync(authored)
    const orders = entity.tables.map((table) => table.executionOrder).sort((a, b) => a - b)
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(orders).size).toBe(orders.length)
    expect(validateEntityDefinition(entity).ok, JSON.stringify(validateEntityDefinition(entity).errors)).toBe(true)
  })

  it("imports rule with resolved pipeline lookup scopes", () => {
    const authored = loadG1Authored("rule")
    const entity = entityDefinitionFromAuthoredSync(authored)
    const validation = validateEntityDefinition(entity)
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(true)
  })
})

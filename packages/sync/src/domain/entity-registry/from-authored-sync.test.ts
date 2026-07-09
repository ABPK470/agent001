import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { entityDefinitionFromAuthoredSync } from "./from-authored-sync.js"
import { looksIncompleteScopePredicate, resolveReviewPlaceholderPredicate } from "./resolve-scope-predicate.js"
import { validateEntityDefinition } from "./validate.js"

const repoRoot = resolve(import.meta.dirname, "../../../../..")

describe("resolveReviewPlaceholderPredicate", () => {
  it("resolves content type lookup scopes from the content tree", () => {
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
    expect(resolved).toContain("{ids}")
    expect(resolved).toContain("[gate].[Content]")
    expect(looksIncompleteScopePredicate(resolved!)).toBe(false)
  })
})

describe("entityDefinitionFromAuthoredSync", () => {
  it("imports deploy artifacts as valid entity definitions", () => {
    const path = resolve(repoRoot, "deploy/sync/artifacts/entities/contract.json")
    const authored = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
    const entity = entityDefinitionFromAuthoredSync(authored)

    const validation = validateEntityDefinition(entity)
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(true)
    expect(entity.id).toBe("contract")
    expect(entity.tables.length).toBeGreaterThan(0)
    expect(entity.legacyEntrySproc).toBe("core.uspSyncCoreObjectsTran")
  })

  it("imports content with resolved lookup-table scopes", () => {
    const path = resolve(repoRoot, "deploy/sync/artifacts/entities/content.json")
    const authored = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
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
    const path = resolve(repoRoot, "deploy/sync/artifacts/entities/gateMetadata.json")
    const authored = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
    const entity = entityDefinitionFromAuthoredSync(authored)
    const orders = entity.tables.map((table) => table.executionOrder).sort((a, b) => a - b)
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(orders).size).toBe(orders.length)
    expect(validateEntityDefinition(entity).ok, JSON.stringify(validateEntityDefinition(entity).errors)).toBe(true)
  })

  it("imports rule with resolved pipeline lookup scopes", () => {
    const path = resolve(repoRoot, "deploy/sync/artifacts/entities/rule.json")
    const authored = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
    const entity = entityDefinitionFromAuthoredSync(authored)
    const validation = validateEntityDefinition(entity)
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(true)
  })
})

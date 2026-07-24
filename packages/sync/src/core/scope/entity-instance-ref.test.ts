import { describe, expect, it } from "vitest"

import { coerceSyncEntityId, isUnresolvedEntityName, parseEntityInstanceRef, pickUniqueEntitySearchHit } from "./entity-instance-ref.js"
import { parseSyncOperationIntent } from "../intent/sync-operation-intent.js"
import type { PublishedSyncDefinition } from "@mia/shared-types"
import { withPermissionDefaults } from "../eligibility/environments.js"

function stubDefinition(id: string, displayName: string): PublishedSyncDefinition {
  return {
    schemaVersion: 1,
    id,
    displayName,
    description: "",
    rootTable: "core.MetaTable",
    idColumn: "id",
    labelColumn: "name",
    selfJoinColumn: null,
    legacy: { pipelineId: null, entrySproc: null },
    governance: { freezeWindowIds: [] },
    strategy: { strategyId: "x", strategyVersion: "latest" },
    bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
    ownership: { team: "t", owner: null, reviewStatus: "reviewed", notes: [] },
    metadata: { tables: [], executionOrder: [], reverseOrder: [], discrepancies: [] },
    executionFlow: { steps: [] },
    provenance: { kind: "manual" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "1"
  }
}

describe("parseEntityInstanceRef", () => {
  it("parses bare numeric ids", () => {
    expect(parseEntityInstanceRef("2545")).toEqual({ entityId: "2545", entityQuery: null })
    expect(parseEntityInstanceRef("#2545")).toEqual({ entityId: "2545", entityQuery: null })
  })

  it("parses table id key forms", () => {
    expect(parseEntityInstanceRef("tableId=2545")).toEqual({ entityId: "2545", entityQuery: null })
    expect(parseEntityInstanceRef("table=2545")).toEqual({ entityId: "2545", entityQuery: null })
    expect(parseEntityInstanceRef("id:2545")).toEqual({ entityId: "2545", entityQuery: null })
  })

  it("parses table + numeric phrase", () => {
    expect(parseEntityInstanceRef("table 2545")).toEqual({ entityId: "2545", entityQuery: null })
  })

  it("keeps display names as query", () => {
    expect(parseEntityInstanceRef("ACSRawTest")).toEqual({
      entityId: null,
      entityQuery: "ACSRawTest"
    })
  })

  it("parses display label with parenthesized numeric id", () => {
    expect(parseEntityInstanceRef("acrstest (#12334)")).toEqual({
      entityId: "12334",
      entityQuery: null
    })
  })
})

describe("coerceSyncEntityId", () => {
  it("coerces display labels and numeric strings", () => {
    expect(coerceSyncEntityId(12334)).toBe(12334)
    expect(coerceSyncEntityId("12334")).toBe(12334)
    expect(coerceSyncEntityId("acrstest (#12334)")).toBe(12334)
  })
})

describe("isUnresolvedEntityName / pickUniqueEntitySearchHit", () => {
  it("treats display names as unresolved and numeric ids as resolved", () => {
    expect(isUnresolvedEntityName("ACSRawTest")).toBe(true)
    expect(isUnresolvedEntityName("acrstest (#12334)")).toBe(false)
    expect(isUnresolvedEntityName(12334)).toBe(false)
  })

  it("picks exact label when fuzzy search returns several", () => {
    const hits = [
      { id: 1, name: "ACSRaw" },
      { id: 2, name: "ACSRawTest" },
      { id: 3, name: "ACSRawTest2" },
    ]
    expect(pickUniqueEntitySearchHit("ACSRawTest", hits)).toEqual({
      ok: true,
      hit: { id: 2, name: "ACSRawTest" },
    })
  })

  it("reports ambiguity when several exact-insensitive or fuzzy-only matches remain", () => {
    expect(
      pickUniqueEntitySearchHit("foo", [
        { id: 1, name: "foobar" },
        { id: 2, name: "food" },
      ]).ok,
    ).toBe(false)
  })
})

describe("parseSyncOperationIntent gate id", () => {
  const definitions = [stubDefinition("gateMetadata", "Gate Metadata")]
  const environments = [
    withPermissionDefaults({ name: "uat", displayName: "UAT", role: "source", ringOrder: 1 }),
    withPermissionDefaults({ name: "dev", displayName: "Development", role: "target", ringOrder: 0 })
  ]

  it("parses sync gate table 2545 as numeric entityId", () => {
    const intent = parseSyncOperationIntent(
      "sync gate table 2545 from uat to dev",
      definitions,
      environments
    )
    expect(intent?.entityType).toBe("gateMetadata")
    expect(intent?.entityId).toBe("2545")
    expect(intent?.entityQuery).toBeNull()
  })

  it("parses explicit tableId key form", () => {
    const intent = parseSyncOperationIntent(
      "sync gate tableId=2545 from uat to dev",
      definitions,
      environments
    )
    expect(intent?.entityId).toBe("2545")
  })
})

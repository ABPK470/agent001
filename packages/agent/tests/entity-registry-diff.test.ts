/**
 * Entity registry — diff tests.
 */

import { describe, expect, it } from "vitest"
import {
  diffEntityDefinitions,
  type EntityDefinition,
  type EntityTable,
} from "../src/sync/entity-registry/index.js"

function table(overrides: Partial<EntityTable> = {}): EntityTable {
  return {
    name: "core.A",
    scope: { kind: "rootPk", column: "aId" },
    executionOrder: 1,
    scd2Override: null,
    verified: true,
    archiveTable: null,
    note: null,
    provenance: { kind: "manual" },
    ...overrides,
  }
}

function def(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    id: "x",
    tenantId: "t",
    displayName: "X",
    description: "",
    rootTable: "core.X",
    idColumn: "xId",
    labelColumn: null,
    selfJoinColumn: null,
    tables: [table()],
    policies: { approvalPolicyId: null, freezeWindowIds: [], riskMultiplier: 1 },
    scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
    lineageRefs: [],
    provenance: { kind: "manual" },
    version: 1,
    versionLabel: null,
    createdBy: "u",
    reason: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    retiredAt: null,
    ...overrides,
  }
}

describe("diffEntityDefinitions", () => {
  it("returns 'created' when prev is null", () => {
    const changes = diffEntityDefinitions(null, def())
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe("created")
  })

  it("returns no changes for identical inputs", () => {
    const d = def()
    expect(diffEntityDefinitions(d, d)).toHaveLength(0)
  })

  it("detects rename", () => {
    const a = def({ displayName: "Old" })
    const b = def({ displayName: "New" })
    const changes = diffEntityDefinitions(a, b)
    expect(changes.some((c) => c.kind === "renamed")).toBe(true)
  })

  it("detects rootTable + idColumn change", () => {
    const a = def()
    const b = def({ rootTable: "core.Y", idColumn: "yId" })
    const kinds = diffEntityDefinitions(a, b).map((c) => c.kind)
    expect(kinds).toContain("rootTableChanged")
    expect(kinds).toContain("idColumnChanged")
  })

  it("detects strategy change", () => {
    const a = def()
    const b = def({ scd2: { strategyId: "generic-scd2", strategyVersion: 1, entityOverride: null } })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "scd2StrategyChanged")).toBe(true)
  })

  it("detects strategy version change", () => {
    const a = def()
    const b = def({ scd2: { strategyId: "mymi-scd2", strategyVersion: 2, entityOverride: null } })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "scd2StrategyChanged")).toBe(true)
  })

  it("detects entity-level scd2 override change", () => {
    const a = def()
    const b = def({
      scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: { identityHandling: "none" } },
    })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "scd2OverrideChanged")).toBe(true)
  })

  it("detects table added", () => {
    const a = def()
    const b = def({
      tables: [table(), table({ name: "core.B", executionOrder: 2 })],
    })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "tableAdded" && c.tableName === "core.B")).toBe(true)
  })

  it("detects table removed", () => {
    const a = def({
      tables: [table(), table({ name: "core.B", executionOrder: 2 })],
    })
    const b = def()
    expect(
      diffEntityDefinitions(a, b).some((c) => c.kind === "tableRemoved" && c.tableName === "core.B"),
    ).toBe(true)
  })

  it("detects scope change on existing table", () => {
    const a = def({ tables: [table({ scope: { kind: "rootPk", column: "aId" } })] })
    const b = def({ tables: [table({ scope: { kind: "sql", predicate: "aId = {id}" } })] })
    const changes = diffEntityDefinitions(a, b)
    expect(changes.some((c) => c.kind === "scopeChanged")).toBe(true)
  })

  it("detects verified flag flip", () => {
    const a = def({ tables: [table({ verified: false })] })
    const b = def({ tables: [table({ verified: true })] })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "verifiedFlagChanged")).toBe(true)
  })

  it("detects reorder of common tables", () => {
    const a = def({
      tables: [table({ name: "core.A" }), table({ name: "core.B", executionOrder: 2 })],
    })
    const b = def({
      tables: [table({ name: "core.B" }), table({ name: "core.A", executionOrder: 2 })],
    })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "tableReordered")).toBe(true)
  })

  it("does NOT report reorder when only adds/removes happen", () => {
    const a = def({ tables: [table({ name: "core.A" })] })
    const b = def({ tables: [table({ name: "core.A" }), table({ name: "core.B", executionOrder: 2 })] })
    const kinds = diffEntityDefinitions(a, b).map((c) => c.kind)
    expect(kinds).toContain("tableAdded")
    expect(kinds).not.toContain("tableReordered")
  })

  it("detects retire + unretire", () => {
    const a = def()
    const b = def({ retiredAt: "2026-06-01T00:00:00.000Z" })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "retired")).toBe(true)
    expect(diffEntityDefinitions(b, a).some((c) => c.kind === "unretired")).toBe(true)
  })

  it("detects policies change", () => {
    const a = def()
    const b = def({ policies: { approvalPolicyId: "dual", freezeWindowIds: ["holidays"], riskMultiplier: 2 } })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "policiesChanged")).toBe(true)
  })

  it("detects lineage change", () => {
    const a = def()
    const b = def({ lineageRefs: [{ object: "publish.Revenue", kind: "view-source", note: null }] })
    expect(diffEntityDefinitions(a, b).some((c) => c.kind === "lineageChanged")).toBe(true)
  })
})

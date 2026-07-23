/**
 * previewSync against the real checked-in bundle (read-only).
 * SQL / diff is mocked — only definition loading and table selection are real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import { isPublishedSyncEntityType } from "../../runtime/published-definitions.js"
import { asEntityId } from "../../domain/types/branded-ids.js"
import { getPublishedSyncDefinition } from "../../runtime/published-definitions.js"
import { selectDefinitionTables } from "../../core/scope/definition-selection.js"
import { REPO_ROOT, createRepoBundleHost } from "../../test-support/repo-bundle.js"
import { previewSync } from "./preview.js"

const diffTableMock = vi.fn()
const fetchEntityDisplayNameMock = vi.fn()
const fetchPkColumnsMock = vi.fn()
const detectCatalogDriftMock = vi.fn()
const evaluateRootParentMock = vi.fn()

vi.mock("../diff-engine/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diff-engine/index.js")>()
  return {
    ...actual,
    diffTable: (...args: unknown[]) => diffTableMock(...args),
  }
})

vi.mock("./search.js", () => ({
  fetchEntityDisplayName: (...args: unknown[]) => fetchEntityDisplayNameMock(...args),
  expandTreeIds: vi.fn().mockResolvedValue(null),
}))

vi.mock("./apply.js", () => ({
  fetchPkColumns: (...args: unknown[]) => fetchPkColumnsMock(...args),
}))

vi.mock("../../runtime/catalog-drift.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/catalog-drift.js")>()
  return {
    ...actual,
    detectCatalogDrift: (...args: unknown[]) => detectCatalogDriftMock(...args),
    // Preview calls this before diffing; return empty column maps so tests stay unit-scoped.
    fetchTableColumnNamesMap: vi.fn().mockResolvedValue(new Map()),
  }
})

vi.mock("./gates/root-parent-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gates/root-parent-preflight.js")>()
  return {
    ...actual,
    evaluateRootParentPreflight: (...args: unknown[]) => evaluateRootParentMock(...args),
  }
})

function emptyTableResult(table: string) {
  return {
    table,
    scopePredicate: "x = 1",
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet: { insert: [], update: [], delete: [] },
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 1,
  }
}

describe("previewSync with real published bundle (read-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntityDisplayNameMock.mockResolvedValue("Rule 42")
    fetchPkColumnsMock.mockResolvedValue(new Map())
    detectCatalogDriftMock.mockResolvedValue({ catalogCompatible: true, issues: [] })
    evaluateRootParentMock.mockResolvedValue({
      ready: true,
      issue: null,
      details: { rootTable: "core.Rule" },
    })
    diffTableMock.mockImplementation(async (_host, tableDef) => emptyTableResult(tableDef.name))
  })

  it("diffs default-included tables from a published entity in the real bundle", async () => {
    const host = createRepoBundleHost()
    expect(isPublishedSyncEntityType(host, "rule")).toBe(true)

    const rule = getPublishedSyncDefinition(host, REPO_ROOT, asEntityId("rule"))
    const expectedTables = selectDefinitionTables(rule, undefined).tables.map((t) => t.name)

    const plan = await previewSync({
      host,
      entityType: "rule",
      entityId: 42,
      source: "DEV",
      target: "UAT",
    })

    expect(plan.executionContract.definitionId).toBe("rule")
    expect(plan.executionContract.metadata.rootTable).toBe("core.Rule")
    expect(plan.tables.map((t) => t.table).sort()).toEqual([...expectedTables].sort())
    expect(diffTableMock).toHaveBeenCalledTimes(expectedTables.length)
  })

  it("copies frozen flow catalog from the published bundle (no live DB merge)", async () => {
    const host = createRepoBundleHost()
    const published = getPublishedSyncDefinition(host, REPO_ROOT, asEntityId("rule"))

    const plan = await previewSync({
      host,
      entityType: "rule",
      entityId: 1,
      source: "DEV",
      target: "UAT",
    })

    expect(published.executionFlow.catalog).toBeDefined()
    expect(plan.executionContract.flow.catalog).toEqual(published.executionFlow.catalog)
    expect(plan.executionContract.flow.catalog?.kinds["metadataSync"]?.handler.type).toBe("metadata_sync")
  })

  it("uses real content recipe topology for preview plan contract metadata", async () => {
    const host = createRepoBundleHost()
    expect(isPublishedSyncEntityType(host, "content")).toBe(true)

    const plan = await previewSync({
      host,
      entityType: "content",
      entityId: 100,
      source: "DEV",
      target: "UAT",
    })

    expect(plan.executionContract.metadata.rootTable).toBe("gate.Content")
    expect(plan.entity.type).toBe("content")
  })
})

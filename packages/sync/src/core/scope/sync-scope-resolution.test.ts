import { describe, expect, it } from "vitest"
import {
  formatSyncScopeResolution,
  resolveSyncScope
} from "./sync-scope-resolution.js"
import type { PublishedSyncDefinition } from "@mia/shared-types"

function stubDefinition(
  id: string,
  displayName: string,
  tables: string[]
): PublishedSyncDefinition {
  return {
    schemaVersion: 1,
    id,
    displayName,
    description: "",
    rootTable: tables[0] ?? "core.X",
    idColumn: "id",
    labelColumn: "name",
    selfJoinColumn: null,
    legacy: { pipelineId: null, entrySproc: null },
    governance: { freezeWindowIds: [] },
    strategy: { strategyId: "x", strategyVersion: "latest" },
    bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
    ownership: { team: "t", owner: null, reviewStatus: "reviewed", notes: [] },
    metadata: {
      tables: tables.map((name) => ({
        name,
        scopeColumn: "id",
        predicate: "id = {id}",
        source: "fk+pipeline" as const,
        verified: true,
        groundedByPipeline: false,
        enabledByDefault: true,
        userControllable: false
      })),
      executionOrder: tables,
      reverseOrder: [...tables].reverse(),
      discrepancies: []
    },
    executionFlow: { steps: [] },
    provenance: { kind: "manual" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "1"
  }
}

const definitions = [
  stubDefinition("contract", "Contract", ["core.Contract", "core.Pipeline", "core.Activity"]),
  stubDefinition("pipelineActivity", "Pipeline & Activities", ["core.Pipeline", "core.Activity", "core.Step"]),
  stubDefinition("dataset", "Dataset", ["core.Dataset", "core.Pipeline"])
]

describe("resolveSyncScope", () => {
  it("ranks pipelineActivity for pipelines and activities query", () => {
    const res = resolveSyncScope("pipelines and activities", definitions)
    expect(res.matches.length).toBeGreaterThan(0)
    expect(res.matches[0]!.entityType).toBe("pipelineActivity")
  })

  it("prefers pipelineActivity when display name matches both terms strongly", () => {
    const res = resolveSyncScope("pipelines and activities", definitions)
    const ids = res.matches.map((m) => m.entityType)
    expect(ids[0]).toBe("pipelineActivity")
    expect(res.top?.entityType).toBe("pipelineActivity")
    expect(res.ambiguous).toBe(false)
  })

  it("flags ambiguity when multiple definitions score similarly", () => {
    const res = resolveSyncScope("pipeline", definitions)
    const ids = res.matches.map((m) => m.entityType)
    expect(ids).toContain("pipelineActivity")
    expect(ids).toContain("contract")
    expect(ids).toContain("dataset")
    if (res.matches.length >= 2) {
      const gap = res.matches[0]!.score - res.matches[1]!.score
      if (gap < 0.12) {
        expect(res.ambiguous).toBe(true)
        expect(res.top).toBeNull()
      }
    }
  })

  it("resolves unambiguous contract query", () => {
    const res = resolveSyncScope("contracts", definitions)
    expect(res.top?.entityType).toBe("contract")
    expect(res.ambiguous).toBe(false)
  })

  it("formats empty resolution helpfully", () => {
    const res = resolveSyncScope("xyzzy", definitions)
    expect(res.matches).toEqual([])
    expect(formatSyncScopeResolution(res)).toMatch(/list_sync_definitions/)
  })
})

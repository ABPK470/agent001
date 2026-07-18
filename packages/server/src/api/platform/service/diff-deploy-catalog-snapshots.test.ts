import { describe, expect, it } from "vitest"
import {
  collectChangedPaths,
  diffDeployCatalogSnapshots,
} from "./diff-deploy-catalog-snapshots.js"
import type { DeployCatalogSnapshot } from "./export-deploy-artifacts.js"

function snapshot(partial: Partial<DeployCatalogSnapshot>): DeployCatalogSnapshot {
  return {
    exportedAt: "2026-07-18T00:00:00.000Z",
    tenantId: "_default",
    syncMetadata: {
      phases: [],
      stepTypes: [],
      customValueSources: [],
      flows: {},
    },
    flowTemplates: { version: 1, flowTemplates: {} },
    strategies: { version: 1, strategies: [] },
    environments: { version: 1, environments: [] },
    entityRegistry: { version: 1, _comment: "", entities: [] },
    syncDefinitionConfigs: { version: 1, _comment: "", configs: [] },
    entityIds: [],
    ...partial,
  }
}

describe("diffDeployCatalogSnapshots", () => {
  it("reports creates, updates with json, and deletes", () => {
    const from = snapshot({
      entityRegistry: {
        version: 1,
        _comment: "",
        entities: [
          { id: "keep", displayName: "Keep", rootTable: "a.A" },
          { id: "gone", displayName: "Gone", rootTable: "a.G" },
          { id: "edit", displayName: "Old", rootTable: "a.E" },
        ],
      },
      entityIds: ["keep", "gone", "edit"],
    })
    const to = snapshot({
      entityRegistry: {
        version: 1,
        _comment: "",
        entities: [
          { id: "keep", displayName: "Keep", rootTable: "a.A" },
          { id: "edit", displayName: "New", rootTable: "a.E" },
          { id: "new", displayName: "New entity", rootTable: "a.N" },
        ],
      },
      entityIds: ["keep", "edit", "new"],
    })

    const diff = diffDeployCatalogSnapshots({
      from,
      to,
      fromVersion: 2,
      toVersion: 3,
      against: "previous",
    })

    const entities = diff.sections.find((section) => section.section === "entities")
    expect(entities?.creates.map((entry) => entry.id)).toEqual(["new"])
    expect(entities?.creates[0]?.afterJson).toContain('"id": "new"')
    expect(entities?.deletes.map((entry) => entry.id)).toEqual(["gone"])
    expect(entities?.deletes[0]?.beforeJson).toContain('"id": "gone"')
    expect(entities?.updates).toHaveLength(1)
    expect(entities?.updates[0]?.id).toBe("edit")
    expect(entities?.updates[0]?.changedPaths).toEqual(["displayName"])
    expect(entities?.updates[0]?.beforeJson).toContain('"displayName": "Old"')
    expect(entities?.updates[0]?.afterJson).toContain('"displayName": "New"')
    expect(diff.changeCount).toBe(3)
  })

  it("treats null from as all creates", () => {
    const to = snapshot({
      entityRegistry: {
        version: 1,
        _comment: "",
        entities: [{ id: "only", displayName: "Only", rootTable: "a.O" }],
      },
      entityIds: ["only"],
    })
    const diff = diffDeployCatalogSnapshots({
      from: null,
      to,
      fromVersion: null,
      toVersion: 1,
      against: "previous",
    })
    expect(diff.sections[0]?.creates.map((entry) => entry.id)).toEqual(["only"])
  })
})

describe("collectChangedPaths", () => {
  it("ignores __meta and _comment", () => {
    const paths = collectChangedPaths(
      { id: "x", displayName: "A", __meta: { version: 1 }, _comment: "old" },
      { id: "x", displayName: "A", __meta: { version: 2 }, _comment: "new" },
      "",
    )
    expect(paths).toEqual([])
  })
})

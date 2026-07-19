/**
 * Compile vs operational publish dirty classification.
 */

import { describe, expect, it } from "vitest"
import { compileAffectedEntityIdsFromDiff } from "../src/api/sync/service/catalog-publish-gap.js"
import type { DeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import type { DeployCatalogSnapshotDiff } from "../src/api/platform/service/diff-deploy-catalog-snapshots.js"
import type { PublishedSyncDefinition } from "@mia/shared-types"

function tipWithEntities(
  entities: Array<Record<string, unknown>>,
  flows: Record<string, { label: string; steps: Array<{ kind: string; phase?: string }> }> = {},
): DeployCatalogSnapshot {
  return {
    exportedAt: "2026-01-01T00:00:00.000Z",
    tenantId: "_default",
    entityIds: entities.map((e) => String(e.id)),
    syncMetadata: {
      version: 1,
      phases: [],
      actions: [],
      valueSources: [],
      flows,
    },
    flowTemplates: { version: 1, flowTemplates: flows },
    strategies: { version: 1, strategies: [] },
    environments: { version: 1, environments: [] },
    entityRegistry: { version: 1, entities },
    syncDefinitionConfigs: null,
  }
}

function publishedBundle(
  defs: Record<string, Partial<PublishedSyncDefinition> & { id: string }>,
) {
  const definitions: Record<string, PublishedSyncDefinition | null> = {}
  for (const [id, def] of Object.entries(defs)) {
    definitions[id] = {
      id,
      displayName: id,
      publishedAt: "2026-01-01T00:00:00.000Z",
      publishedVersion: "v1",
      provenance: { sourceVersion: "1", ...(def.provenance ?? {}) },
      executionFlow: def.executionFlow ?? { steps: [] },
      ...def,
    } as PublishedSyncDefinition
  }
  return {
    version: 1 as const,
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "v1",
    catalogVersion: 1,
    definitions,
  }
}

function diffSections(
  sections: Array<{
    section: DeployCatalogSnapshotDiff["sections"][number]["section"]
    ids: string[]
  }>,
): DeployCatalogSnapshotDiff {
  return {
    fromVersion: 1,
    toVersion: 2,
    against: "version",
    changeCount: sections.reduce((n, s) => n + s.ids.length, 0),
    impact: {
      creates: [],
      updates: sections.flatMap((s) => s.ids.map((id) => `${s.section}:${id}`)),
      deletes: [],
    },
    sections: sections.map((s) => ({
      section: s.section,
      label: s.section,
      creates: [],
      updates: s.ids.map((id) => ({
        id,
        kind: "update" as const,
        changedPaths: ["x"],
        beforeJson: "{}",
        afterJson: "{}",
      })),
      deletes: [],
    })),
  }
}

describe("compileAffectedEntityIdsFromDiff", () => {
  it("marks only entities that reference a changed action", () => {
    const tip = tipWithEntities(
      [
        { id: "rule", version: 1, flowId: "rule", scd2: { strategyId: "default" } },
        { id: "dataset", version: 1, flowId: "dataset", scd2: { strategyId: "default" } },
      ],
      {
        rule: { label: "Rule", steps: [{ kind: "fetchRows", phase: "extract" }] },
        dataset: { label: "Dataset", steps: [{ kind: "otherKind", phase: "extract" }] },
      },
    )
    const published = publishedBundle({
      rule: {
        id: "rule",
        executionFlow: {
          steps: [{ kind: "fetchRows", phase: "extract" }],
          catalog: { phases: {}, kinds: { fetchRows: {} as never }, customValueSources: {} },
        },
      },
      dataset: {
        id: "dataset",
        executionFlow: {
          steps: [{ kind: "otherKind", phase: "extract" }],
          catalog: { phases: {}, kinds: { otherKind: {} as never }, customValueSources: {} },
        },
      },
    })
    const affected = compileAffectedEntityIdsFromDiff({
      tip,
      published,
      diff: diffSections([{ section: "actions", ids: ["fetchRows"] }]),
    })
    expect(affected.sort()).toEqual(["rule"])
  })

  it("does not mark entities for environment-only tip deltas", () => {
    const tip = tipWithEntities([
      { id: "rule", version: 1, flowId: "rule", scd2: { strategyId: "default" } },
    ])
    const published = publishedBundle({
      rule: { id: "rule" },
    })
    const affected = compileAffectedEntityIdsFromDiff({
      tip,
      published,
      diff: diffSections([{ section: "environments", ids: ["UAT"] }]),
    })
    expect(affected).toEqual([])
  })

  it("marks entity when tip entity version drifts from published provenance", () => {
    const tip = tipWithEntities([
      { id: "rule", version: 2, flowId: "rule", scd2: { strategyId: "default" } },
    ])
    const published = publishedBundle({
      rule: { id: "rule", provenance: { sourceVersion: "1" } },
    })
    const affected = compileAffectedEntityIdsFromDiff({
      tip,
      published,
      diff: null,
    })
    expect(affected).toEqual(["rule"])
  })
})

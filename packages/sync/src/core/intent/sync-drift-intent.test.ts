import { describe, expect, it } from "vitest"
import { parseSyncDriftIntent } from "./sync-drift-intent.js"
import type { PublishedSyncDefinition } from "./published-definitions.js"
import { withPermissionDefaults } from "./environments.js"

function stubDefinition(id: string, displayName: string): PublishedSyncDefinition {
  return {
    schemaVersion: 1,
    id,
    displayName,
    description: "",
    rootTable: "core.Pipeline",
    idColumn: "pipelineId",
    labelColumn: "name",
    selfJoinColumn: null,
    legacy: { pipelineId: null, entrySproc: null },
    governance: { freezeWindowIds: [] },
    strategy: { strategyId: "x", strategyVersion: "latest" },
    bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
    ownership: { team: "t", owner: null, reviewStatus: "reviewed", notes: [] },
    metadata: {
      tables: [
        {
          name: "core.Pipeline",
          scopeColumn: "pipelineId",
          predicate: "pipelineId = {id}",
          source: "fk+pipeline",
          verified: true,
          groundedByPipeline: true,
          enabledByDefault: true,
          userControllable: false
        },
        {
          name: "core.Activity",
          scopeColumn: "pipelineId",
          predicate: "pipelineId = {id}",
          source: "fk+pipeline",
          verified: true,
          groundedByPipeline: true,
          enabledByDefault: true,
          userControllable: false
        }
      ],
      executionOrder: ["core.Pipeline", "core.Activity"],
      reverseOrder: ["core.Activity", "core.Pipeline"],
      discrepancies: []
    },
    executionFlow: { steps: [] },
    provenance: { kind: "manual" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedVersion: "1"
  }
}

const environments = [
  withPermissionDefaults({ name: "uat", displayName: "UAT", role: "source", ringOrder: 1 }),
  withPermissionDefaults({ name: "dev", displayName: "Development", role: "target", ringOrder: 0 })
]

describe("parseSyncDriftIntent", () => {
  it("parses cross-env drift question with scope", () => {
    const intent = parseSyncDriftIntent(
      "what pipelne and activites are out of sync between uat (source) and dev (target)?",
      [stubDefinition("pipelineActivity", "Pipeline & Activities")],
      environments
    )
    expect(intent).not.toBeNull()
    expect(intent!.source).toBe("uat")
    expect(intent!.target).toBe("dev")
    expect(intent!.scopeQuery).toMatch(/pipelne/)
    expect(intent!.scope?.matches[0]?.entityType).toBe("pipelineActivity")
  })

  it("returns null without drift vocabulary", () => {
    expect(
      parseSyncDriftIntent("show pipelines between uat and dev", [], environments)
    ).toBeNull()
  })
})

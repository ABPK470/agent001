import { describe, expect, it } from "vitest"

import type { SyncExecuteProgress, SyncPlan } from "../../types"
import { buildDeployProgress, deployStepsFromPlan } from "./exec-deploy-status"

function planWithDeploySteps(): SyncPlan {
  return {
    planId: "p1",
    createdAt: new Date(0).toISOString(),
    createdAtMs: 0,
    entity: { type: "contract", id: 1, displayName: "C" },
    source: "DEV",
    target: "UAT",
    preflight: {
      catalogCompatible: true,
      issues: [],
      rootParentReady: true,
      rootParentIssue: null,
    },
    tables: [],
    totals: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 0 },
    dependencyGraph: { nodes: [], edges: [] },
    warnings: [],
    estimatedDurationSec: 1,
    executionContract: {
      definitionId: "contract",
      definitionPublishedVersion: "v1",
      definitionPublishedAt: new Date(0).toISOString(),
      governance: { freezeWindowIds: [] },
      bindings: { serviceProfileRef: "default", environmentPolicyRef: "default" },
      allowedSchemas: ["core"],
      metadata: { rootTable: "core.Contract", rootKeyColumn: "contractId", selfJoinColumn: null, tables: [], executionOrder: [], reverseOrder: [], enabledOptionalTables: [] },
      flow: {
        steps: [
          { id: "metadata-sync", phase: "metadata", kind: "metadata-sync", title: "m", description: "m" },
          { id: "contract-create-dataset-stage", phase: "postMetadata", kind: "contract-create-stage-dataset", title: "s", description: "s" },
          { id: "contract-deploy-etl", phase: "postMetadata", kind: "contract-deploy-etl", title: "e", description: "e" }
        ]
      },
      provenance: { kind: "manual" }
    }
  } as SyncPlan
}

describe("exec-deploy-status", () => {
  it("lists post-metadata steps from plan", () => {
    expect(deployStepsFromPlan(planWithDeploySteps())).toEqual([
      "contract-create-dataset-stage",
      "contract-deploy-etl"
    ])
  })

  it("counts deploy-step done, failed, and skipped", () => {
    const plan = planWithDeploySteps()
    const events: SyncExecuteProgress[] = [
      { type: "deploy-step", step: "contract-create-dataset-stage", deployStatus: "started" },
      { type: "deploy-step", step: "contract-create-dataset-stage", deployStatus: "failed", error: "boom" },
      { type: "deploy-step", step: "contract-deploy-etl", deployStatus: "started" },
      { type: "deploy-step", step: "contract-deploy-etl", deployStatus: "skipped", message: "skipped" }
    ]
    expect(buildDeployProgress(events, plan)).toEqual({
      total: 2,
      done: 0,
      failed: 1,
      skipped: 1
    })
  })
})

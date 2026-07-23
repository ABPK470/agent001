import { describe, expect, it } from "vitest"

import type { SyncExecutionContractStep } from "../../plan-store.js"
import { scheduleFlowSteps } from "./flow-scheduler.js"

function step(
  partial: Partial<SyncExecutionContractStep> & Pick<SyncExecutionContractStep, "id" | "kind">,
): SyncExecutionContractStep {
  return {
    phase: "postMetadata",
    title: partial.id,
    description: partial.id,
    objectName: null,
    auditObjectType: null,
    pipelineName: null,
    ...partial,
  }
}

describe("scheduleFlowSteps", () => {
  it("splits at metadataSync by array position", () => {
    const scheduled = scheduleFlowSteps([
      step({ id: "audit", kind: "auditCheck", auditObjectType: "contract" }),
      step({ id: "meta", kind: "metadataSync" }),
      step({ id: "deploy", kind: "contractDeployEtl" }),
      step({ id: "unlock", kind: "targetUnlock" }),
    ])
    expect(scheduled.beforeMetadata.map((s) => s.id)).toEqual(["audit"])
    expect(scheduled.metadata.id).toBe("meta")
    expect(scheduled.afterMetadata.map((s) => s.id)).toEqual(["deploy", "unlock"])
  })

  it("rejects flows without exactly one metadataSync", () => {
    expect(() =>
      scheduleFlowSteps([step({ id: "audit", kind: "auditCheck", auditObjectType: "contract" })]),
    ).toThrow(/exactly one metadataSync/i)
  })
})

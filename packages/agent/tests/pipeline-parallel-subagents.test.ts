/**
 * Hard proof: independent subagent_task steps actually overlap in time.
 *
 * peakInFlight === 3 with maxParallel: 4 means the scheduler launched all
 * three together. If it were secretly serial, peak would stay at 1 (see
 * the control test).
 */

import { describe, expect, it } from "vitest"
import { executePipeline } from "../src/core/plan.js"
import type { Plan, SubagentTaskStep } from "../src/core/plan.js"

function evidenceStep(name: string, artifact: string): SubagentTaskStep {
  return {
    name,
    stepType: "subagent_task",
    objective: `Investigate ${name}`,
    inputContract: "n/a",
    acceptanceCriteria: ["done"],
    requiredToolCapabilities: ["query_mssql", "write_file", "read_file"],
    contextRequirements: [],
    maxBudgetHint: "10",
    canRunParallel: true,
    executionContext: {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      allowedTools: ["query_mssql", "write_file", "read_file"],
      requiredSourceArtifacts: [],
      targetArtifacts: [artifact],
      effectClass: "filesystem_write",
      verificationMode: "none",
      artifactRelations: [],
    },
  }
}

describe("pipeline parallel subagents — concurrency proof", () => {
  it("runs three independent subagent steps with peak in-flight of 3", async () => {
    const plan: Plan = {
      reason: "fan-out proof",
      confidence: 1,
      requiresSynthesis: true,
      steps: [
        evidenceStep("inspect_a", "tmp/a/evidence_summary.json"),
        evidenceStep("inspect_b", "tmp/b/evidence_summary.json"),
        evidenceStep("inspect_c", "tmp/c/evidence_summary.json"),
      ],
      edges: [],
    }

    let inFlight = 0
    let peakInFlight = 0
    const entered = new Set<string>()
    const releaseAll = Promise.withResolvers<void>()

    await executePipeline(
      plan,
      [],
      async (step) => {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        entered.add(step.name)

        if (entered.size >= 3) releaseAll.resolve()
        await releaseAll.promise

        inFlight--
        const path =
          step.stepType === "subagent_task"
            ? step.executionContext.targetArtifacts[0]!
            : `tmp/${step.name}.json`
        return {
          output: `${step.name} done`,
          toolCalls: [
            {
              name: "write_file",
              args: { path, content: "{}" },
              result: `Successfully wrote to ${path}`,
              isError: false,
            },
            {
              name: "read_file",
              args: { path },
              result: "{}",
              isError: false,
            },
          ],
        }
      },
      { maxParallel: 4 },
    )

    expect(peakInFlight).toBe(3)
    expect(entered.size).toBe(3)
  })

  it("stays serial when maxParallel is 1 (control)", async () => {
    const plan: Plan = {
      reason: "serial control",
      confidence: 1,
      requiresSynthesis: true,
      steps: [
        evidenceStep("solo_a", "tmp/a.json"),
        evidenceStep("solo_b", "tmp/b.json"),
      ],
      edges: [],
    }

    let inFlight = 0
    let peakInFlight = 0

    await executePipeline(
      plan,
      [],
      async (step) => {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        const path =
          step.stepType === "subagent_task"
            ? step.executionContext.targetArtifacts[0]!
            : `tmp/${step.name}.json`
        return {
          output: "ok",
          toolCalls: [
            {
              name: "write_file",
              args: { path, content: "{}" },
              result: `Successfully wrote to ${path}`,
              isError: false,
            },
            {
              name: "read_file",
              args: { path },
              result: "{}",
              isError: false,
            },
          ],
        }
      },
      { maxParallel: 1 },
    )

    expect(peakInFlight).toBe(1)
  })
})

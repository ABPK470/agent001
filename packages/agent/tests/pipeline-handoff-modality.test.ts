/**
 * Same-pass DAG handoffs must not wait for post-pipeline verifier
 * acceptance — verify runs only after the full pass.
 */
import { describe, expect, it } from "vitest"
import { detectVerificationModalityGaps } from "../src/core/plan/internal/verifier-llm.js"
import {
  collectAcceptedArtifacts,
  collectRunnableUpstreamArtifacts,
  getUnresolvedAcceptanceBlockers
} from "../src/core/plan/pipeline-repair/reconcile.js"
import { compilePlannerRuntime } from "../src/core/plan/runtime-model.js"
import { executePipeline } from "../src/core/plan.js"
import type { Plan, PipelineStepResult, SubagentTaskStep, Tool } from "../src/core/plan.js"

function echoTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute() {
      return "ok"
    }
  }
}

function makeStep(name: string, opts: {
  targets: string[]
  sources?: string[]
  effectClass?: "readonly" | "filesystem_write"
  criteria?: string[]
}): SubagentTaskStep {
  return {
    name,
    stepType: "subagent_task",
    objective: `Investigate and write ${opts.targets.join(", ")} using catalog/query tools`,
    inputContract: "Empty workspace",
    acceptanceCriteria: opts.criteria ?? ["Query the database and write grounded evidence"],
    requiredToolCapabilities: ["write_file", "read_file", "search_catalog", "query_mssql"],
    contextRequirements: [],
    maxBudgetHint: "10 iterations",
    canRunParallel: false,
    dependsOn: opts.sources?.length ? ["discover"] : undefined,
    executionContext: {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      allowedTools: ["write_file", "read_file", "search_catalog", "query_mssql"],
      requiredSourceArtifacts: opts.sources ?? [],
      targetArtifacts: opts.targets,
      effectClass: opts.effectClass ?? "filesystem_write",
      verificationMode: "none",
      artifactRelations: [
        ...opts.targets.map((artifactPath) => ({
          relationType: "write_owner" as const,
          artifactPath
        })),
        ...(opts.sources ?? []).map((artifactPath) => ({
          relationType: "read_dependency" as const,
          artifactPath
        }))
      ]
    }
  }
}

describe("same-pass upstream handoff", () => {
  it("treats pending_verification producers as runnable for dependents", () => {
    const discover = makeStep("discover", {
      targets: ["tmp/client_offer_grounding/schema_discovery.json"]
    })
    const inspect = makeStep("inspect", {
      targets: ["tmp/client_offer_grounding/revenue_definition_analysis.json"],
      sources: ["tmp/client_offer_grounding/schema_discovery.json"]
    })
    const plan: Plan = {
      reason: "type-b investigation",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [discover, inspect],
      edges: [{ from: "discover", to: "inspect" }]
    }
    const runtimeModel = compilePlannerRuntime(plan)
    const stepResults = new Map<string, PipelineStepResult>([
      [
        "discover",
        {
          name: "discover",
          status: "completed",
          executionState: "executed",
          acceptanceState: "pending_verification",
          durationMs: 1,
          producedArtifacts: ["tmp/client_offer_grounding/schema_discovery.json"],
          modifiedArtifacts: ["tmp/client_offer_grounding/schema_discovery.json"]
        }
      ]
    ])

    const accepted = collectAcceptedArtifacts(undefined, stepResults)
    const runnable = collectRunnableUpstreamArtifacts(undefined, stepResults)
    expect(accepted.size).toBe(0)
    expect(runnable.has("tmp/client_offer_grounding/schema_discovery.json")).toBe(true)

    const blockers = getUnresolvedAcceptanceBlockers(
      "inspect",
      runtimeModel,
      undefined,
      accepted,
      runnable
    )
    expect(blockers).toEqual([])
  })

  it("runs the consumer in the same pipeline pass after the producer writes", async () => {
    const discover = makeStep("discover", {
      targets: ["tmp/schema_discovery.json"]
    })
    const inspect = makeStep("inspect", {
      targets: ["tmp/revenue_definition_analysis.json"],
      sources: ["tmp/schema_discovery.json"]
    })
    const plan: Plan = {
      reason: "type-b investigation",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [discover, inspect],
      edges: [{ from: "discover", to: "inspect" }]
    }
    const calls: string[] = []
    const result = await executePipeline(
      plan,
      [echoTool("write_file"), echoTool("read_file")],
      async (step) => {
        calls.push(step.name)
        return {
          output: `wrote ${step.executionContext.targetArtifacts.join(", ")}`,
          toolCalls: [
            {
              name: "write_file",
              args: {
                path: step.executionContext.targetArtifacts[0]!,
                content: "{}"
              },
              result: "ok",
              isError: false
            },
            {
              name: "read_file",
              args: { path: step.executionContext.targetArtifacts[0]! },
              result: "{}",
              isError: false
            }
          ],
          execution: {
            status: "success",
            summary: `done ${step.name}`,
            producedArtifacts: step.executionContext.targetArtifacts,
            modifiedArtifacts: step.executionContext.targetArtifacts,
            verificationAttempts: [],
            unresolvedBlockers: []
          }
        }
      },
      { runtimeModel: compilePlannerRuntime(plan) }
    )

    expect(calls).toEqual(["discover", "inspect"])
    expect(result.stepResults.get("inspect")?.status).not.toBe("skipped")
    expect(result.stepResults.get("inspect")?.error ?? "").not.toMatch(
      /Waiting on accepted upstream artifacts/i
    )
  })
})

describe("investigation modality", () => {
  it("does not demand runtime probes for JSON evidence with query wording", () => {
    const step = makeStep("inspect_revenue_definition", {
      targets: ["tmp/client_offer_grounding/revenue_definition_analysis.json"],
      effectClass: "readonly",
      criteria: [
        "Query publish.Revenue and write the definition analysis JSON",
        "Database evidence must ground the client answer"
      ]
    })
    const gaps = detectVerificationModalityGaps(step, new Set(["artifact-review"]), new Map())
    expect(gaps.every((g) => !/runtime probe/i.test(g))).toBe(true)
  })
})

import { describe, expect, it } from "vitest"
import {
  preparePlanParallelism,
  pruneSpuriousSerialEdges
} from "../src/core/plan/normalize/parallelism.js"
import { buildGraph } from "../src/core/plan/pipeline/graph.js"
import type { Plan, SubagentTaskStep } from "../src/core/plan.js"

function makeStep(
  name: string,
  opts: {
    targets: string[]
    sources?: string[]
    canRunParallel?: boolean
    effectClass?: "readonly" | "filesystem_write"
    dependsOn?: string[]
  }
): SubagentTaskStep {
  return {
    name,
    stepType: "subagent_task",
    objective: `Do ${name}`,
    inputContract: "n/a",
    acceptanceCriteria: ["done"],
    requiredToolCapabilities: ["search_catalog"],
    contextRequirements: [],
    maxBudgetHint: "10",
    canRunParallel: opts.canRunParallel ?? false,
    dependsOn: opts.dependsOn,
    executionContext: {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      allowedTools: ["search_catalog", "write_file"],
      requiredSourceArtifacts: opts.sources ?? [],
      targetArtifacts: opts.targets,
      effectClass: opts.effectClass ?? "readonly",
      verificationMode: "none",
      artifactRelations: []
    }
  }
}

describe("preparePlanParallelism", () => {
  it("marks independent investigation steps and prunes fake serial edges", () => {
    const plan: Plan = {
      reason: "fan-out",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("inspect_a", {
          targets: ["tmp/a.json"],
          dependsOn: undefined
        }),
        makeStep("inspect_b", {
          targets: ["tmp/b.json"],
          dependsOn: ["inspect_a"]
        }),
        makeStep("inspect_c", {
          targets: ["tmp/c.json"],
          dependsOn: ["inspect_b"]
        })
      ],
      edges: [
        { from: "inspect_a", to: "inspect_b" },
        { from: "inspect_b", to: "inspect_c" }
      ]
    }

    const result = preparePlanParallelism(plan)
    expect(result.marked).toBe(3)
    expect(result.prunedEdges).toBe(2)
    expect(plan.edges).toEqual([])

    const graph = buildGraph(plan)
    expect(graph.inDegree.get("inspect_a")).toBe(0)
    expect(graph.inDegree.get("inspect_b")).toBe(0)
    expect(graph.inDegree.get("inspect_c")).toBe(0)
  })

  it("keeps real artifact handoff edges", () => {
    const plan: Plan = {
      reason: "handoff",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("discover", {
          targets: ["tmp/schema.json"],
          effectClass: "filesystem_write"
        }),
        makeStep("analyze", {
          targets: ["tmp/analysis.json"],
          sources: ["tmp/schema.json"],
          dependsOn: ["discover"],
          effectClass: "filesystem_write"
        })
      ],
      edges: [{ from: "discover", to: "analyze" }]
    }

    // discover is evidence write → parallelizable; analyze reads upstream → not marked
    preparePlanParallelism(plan)
    expect(plan.edges).toEqual([{ from: "discover", to: "analyze" }])
  })

  it("keeps blueprint edges even when peers are parallelizable", () => {
    const plan: Plan = {
      reason: "codegen",
      confidence: 0.9,
      requiresSynthesis: false,
      steps: [
        makeStep("generate_blueprint", {
          targets: ["tmp/BLUEPRINT.md"],
          canRunParallel: false,
          effectClass: "filesystem_write"
        }),
        makeStep("build_a", {
          targets: ["tmp/a.js"],
          canRunParallel: true,
          dependsOn: ["generate_blueprint"],
          effectClass: "filesystem_write"
        }),
        makeStep("build_b", {
          targets: ["tmp/b.js"],
          canRunParallel: true,
          dependsOn: ["generate_blueprint"],
          effectClass: "filesystem_write"
        })
      ],
      edges: [
        { from: "generate_blueprint", to: "build_a" },
        { from: "generate_blueprint", to: "build_b" },
        { from: "build_a", to: "build_b" }
      ]
    }

    const pruned = pruneSpuriousSerialEdges(plan)
    expect(pruned).toBe(1)
    expect(plan.edges).toEqual([
      { from: "generate_blueprint", to: "build_a" },
      { from: "generate_blueprint", to: "build_b" }
    ])
  })
})

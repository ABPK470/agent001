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

  it("fans out empty-target catalog steps even when LLM defaults effectClass to filesystem_write", () => {
    const plan: Plan = {
      reason: "catalog fan-out",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("probe_revenue", {
          targets: [],
          effectClass: "filesystem_write",
          dependsOn: undefined,
        }),
        makeStep("probe_balances", {
          targets: [],
          effectClass: "filesystem_write",
          dependsOn: ["probe_revenue"],
        }),
        makeStep("probe_clients", {
          targets: [],
          effectClass: "filesystem_write",
          dependsOn: ["probe_balances"],
        }),
      ],
      edges: [
        { from: "probe_revenue", to: "probe_balances" },
        { from: "probe_balances", to: "probe_clients" },
      ],
    }

    const result = preparePlanParallelism(plan)
    expect(result.marked).toBe(3)
    expect(result.prunedEdges).toBe(2)
    expect(plan.edges).toEqual([])

    const graph = buildGraph(plan)
    expect([...graph.inDegree.values()].every((deg) => deg === 0)).toBe(true)
  })

  it("prunes thematic readonly chains with no artifact handoff", () => {
    const plan: Plan = {
      reason: "readonly chain",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("a", {
          targets: ["tmp/a.json"],
          effectClass: "readonly",
        }),
        makeStep("b", {
          targets: ["tmp/b.json"],
          effectClass: "readonly",
          dependsOn: ["a"],
        }),
      ],
      edges: [{ from: "a", to: "b" }],
    }

    const result = preparePlanParallelism(plan)
    expect(result.prunedEdges).toBe(1)
    expect(plan.edges).toEqual([])
  })

  it("strips investigation↔investigation evidence handoffs (edges + sources)", () => {
    const plan: Plan = {
      reason: "readonly evidence chain",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("a", {
          targets: ["tmp/a.json"],
          effectClass: "readonly",
        }),
        makeStep("b", {
          targets: ["tmp/b.json"],
          sources: ["tmp/a.json"],
          effectClass: "readonly",
          dependsOn: ["a"],
        }),
      ],
      edges: [{ from: "a", to: "b" }],
    }

    const result = preparePlanParallelism(plan)
    expect(result.strippedSources).toBe(1)
    expect(result.prunedEdges).toBe(1)
    expect(plan.edges).toEqual([])
    expect(plan.steps[1]?.stepType === "subagent_task" &&
      (plan.steps[1] as SubagentTaskStep).executionContext.requiredSourceArtifacts).toEqual([])
    expect(buildGraph(plan).inDegree.get("b")).toBe(0)
  })

  it("keeps evidence→write-answer handoff (required write_file is not investigation)", () => {
    const plan: Plan = {
      reason: "analyze then write answer",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("analyze", {
          targets: ["tmp/grounding.json"],
          effectClass: "readonly",
        }),
        makeStep("write_answer", {
          targets: ["tmp/client_answer.md"],
          sources: ["tmp/grounding.json"],
          dependsOn: ["analyze"],
          effectClass: "filesystem_write",
          canRunParallel: false,
        }),
      ],
      edges: [{ from: "analyze", to: "write_answer" }],
    }
    const write = plan.steps[1] as SubagentTaskStep
    ;(write as { requiredToolCapabilities: string[] }).requiredToolCapabilities = [
      "write_file",
    ]

    preparePlanParallelism(plan)
    expect(plan.edges).toEqual([{ from: "analyze", to: "write_answer" }])
    expect(write.executionContext.requiredSourceArtifacts).toEqual(["tmp/grounding.json"])
    expect(buildGraph(plan).inDegree.get("write_answer")).toBe(1)
  })

  it("keeps shared write-target edges so peers cannot crush the same file", () => {
    const plan: Plan = {
      reason: "shared target",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("writer_a", {
          targets: ["tmp/shared.json"],
          canRunParallel: true,
          effectClass: "filesystem_write",
        }),
        makeStep("writer_b", {
          targets: ["tmp/shared.json"],
          canRunParallel: true,
          dependsOn: ["writer_a"],
          effectClass: "filesystem_write",
        }),
      ],
      edges: [{ from: "writer_a", to: "writer_b" }],
    }

    preparePlanParallelism(plan)
    expect(plan.edges).toEqual([{ from: "writer_a", to: "writer_b" }])
  })

  it("keeps real deliverable handoff edges (code consumer)", () => {
    const plan: Plan = {
      reason: "handoff",
      confidence: 0.9,
      requiresSynthesis: true,
      steps: [
        makeStep("discover", {
          targets: ["tmp/schema.json"],
          effectClass: "filesystem_write"
        }),
        makeStep("implement", {
          targets: ["src/report.ts"],
          sources: ["tmp/schema.json"],
          dependsOn: ["discover"],
          effectClass: "filesystem_write",
          canRunParallel: false,
        })
      ],
      edges: [{ from: "discover", to: "implement" }]
    }
    const implement = plan.steps[1] as SubagentTaskStep
    ;(implement as { requiredToolCapabilities: string[] }).requiredToolCapabilities = [
      "write_file",
    ]

    preparePlanParallelism(plan)
    expect(plan.edges).toEqual([{ from: "discover", to: "implement" }])
    expect(implement.executionContext.requiredSourceArtifacts).toEqual(["tmp/schema.json"])
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

  it("prunes thematic codegen chains even when canRunParallel is false", () => {
    const plan: Plan = {
      reason: "four writers",
      confidence: 0.9,
      requiresSynthesis: false,
      steps: [
        makeStep("generate_blueprint", {
          targets: ["tmp/BLUEPRINT.md"],
          effectClass: "filesystem_write",
        }),
        makeStep("layer_a", {
          targets: ["tmp/a.js"],
          sources: ["tmp/BLUEPRINT.md"],
          dependsOn: ["generate_blueprint"],
          effectClass: "filesystem_write",
        }),
        makeStep("layer_b", {
          targets: ["tmp/b.js"],
          sources: ["tmp/BLUEPRINT.md"],
          dependsOn: ["layer_a"],
          effectClass: "filesystem_write",
        }),
        makeStep("layer_c", {
          targets: ["tmp/c.js"],
          sources: ["tmp/BLUEPRINT.md"],
          dependsOn: ["layer_b"],
          effectClass: "filesystem_write",
        }),
        makeStep("layer_d", {
          targets: ["tmp/d.js"],
          sources: ["tmp/BLUEPRINT.md"],
          dependsOn: ["layer_c"],
          effectClass: "filesystem_write",
        }),
      ],
      edges: [
        { from: "generate_blueprint", to: "layer_a" },
        { from: "generate_blueprint", to: "layer_b" },
        { from: "generate_blueprint", to: "layer_c" },
        { from: "generate_blueprint", to: "layer_d" },
        { from: "layer_a", to: "layer_b" },
        { from: "layer_b", to: "layer_c" },
        { from: "layer_c", to: "layer_d" },
      ],
    }

    preparePlanParallelism(plan)
    expect(plan.edges).toEqual([
      { from: "generate_blueprint", to: "layer_a" },
      { from: "generate_blueprint", to: "layer_b" },
      { from: "generate_blueprint", to: "layer_c" },
      { from: "generate_blueprint", to: "layer_d" },
    ])
    const graph = buildGraph(plan)
    expect(graph.inDegree.get("generate_blueprint")).toBe(0)
    expect(graph.inDegree.get("layer_a")).toBe(1)
    expect(graph.inDegree.get("layer_b")).toBe(1)
    expect(graph.inDegree.get("layer_c")).toBe(1)
    expect(graph.inDegree.get("layer_d")).toBe(1)
  })
})

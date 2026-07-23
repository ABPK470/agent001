/**
 * Codegen blueprint is for multi-file implementation — not investigation
 * evidence (JSON/MD). Injecting BLUEPRINT.md for data plans deadlocks on
 * SPEC FUNCTION MISMATCH inventing APIs inside JSON files.
 */
import { describe, expect, it } from "vitest"
import {
  isCodeLikeArtifact,
  isImplementationArtifact,
  planNeedsCodegenBlueprint
} from "../src/core/plan/blueprint-contract/index.js"
import {
  injectBlueprintStep,
  strengthenExistingBlueprintSteps
} from "../src/core/plan/internal/index-blueprint.js"
import type { Plan, SubagentTaskStep } from "../src/core/plan.js"

function makeStep(name: string, targetArtifacts: string[]): SubagentTaskStep {
  return {
    name,
    stepType: "subagent_task",
    objective: `Produce ${targetArtifacts.join(", ")}`,
    inputContract: "Empty workspace",
    acceptanceCriteria: ["artifacts written"],
    requiredToolCapabilities: ["write_file", "read_file"],
    contextRequirements: [],
    maxBudgetHint: "10 iterations",
    canRunParallel: true,
    executionContext: {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      allowedTools: ["write_file", "read_file"],
      requiredSourceArtifacts: [],
      targetArtifacts,
      effectClass: "filesystem_write",
      verificationMode: "none",
      artifactRelations: []
    }
  }
}

function makePlan(steps: SubagentTaskStep[]): Plan {
  return {
    reason: "test",
    confidence: 0.9,
    requiresSynthesis: true,
    steps,
    edges: []
  }
}

describe("blueprint codegen gate", () => {
  it("classifies code vs evidence artifacts", () => {
    expect(isCodeLikeArtifact("tmp/a.ts")).toBe(true)
    expect(isCodeLikeArtifact("tmp/schema_discovery.json")).toBe(false)
    expect(isImplementationArtifact("tmp/index.html")).toBe(true)
    expect(isImplementationArtifact("tmp/report.md")).toBe(false)
  })

  it("does not require a blueprint for investigation JSON/MD plans", () => {
    const plan = makePlan([
      makeStep("catalog_discovery", ["tmp/client_offer_grounding/schema_discovery.json"]),
      makeStep("inspect_revenue", ["tmp/client_offer_grounding/revenue_definition.md"]),
      makeStep("query_evidence", ["tmp/client_offer_grounding/business_evidence.json"]),
      makeStep("write_answer", ["tmp/client_offer_grounding/client_answer.md"])
    ])
    expect(planNeedsCodegenBlueprint(plan)).toBe(false)

    injectBlueprintStep(plan, ".", "tmp")
    expect(plan.steps.some((s) => s.name === "generate_blueprint")).toBe(false)
  })

  it("still injects a blueprint for multi-file HTML+JS codegen", () => {
    const plan = makePlan([
      makeStep("build_markup", ["tmp/index.html"]),
      makeStep("build_logic", ["tmp/game_logic.js"])
    ])
    expect(planNeedsCodegenBlueprint(plan)).toBe(true)

    injectBlueprintStep(plan, ".", "tmp")
    expect(plan.steps.some((s) => s.name === "generate_blueprint")).toBe(true)
    const logic = plan.steps.find((s) => s.name === "build_logic") as SubagentTaskStep
    expect(logic.dependsOn).toContain("generate_blueprint")
    expect(logic.executionContext.requiredSourceArtifacts).toContain("tmp/BLUEPRINT.md")
  })

  it("does not force investigation steps to wait on an incidental blueprint step", () => {
    const plan = makePlan([
      makeStep("generate_blueprint", ["tmp/BLUEPRINT.md"]),
      makeStep("catalog_discovery", ["tmp/schema_discovery.json"]),
      makeStep("write_answer", ["tmp/client_answer.md"])
    ])

    strengthenExistingBlueprintSteps(plan, ".", "tmp")

    const discovery = plan.steps.find((s) => s.name === "catalog_discovery") as SubagentTaskStep
    expect(discovery.dependsOn ?? []).not.toContain("generate_blueprint")
    expect(discovery.executionContext.requiredSourceArtifacts).not.toContain("tmp/BLUEPRINT.md")

    const blueprint = plan.steps.find((s) => s.name === "generate_blueprint") as SubagentTaskStep
    expect(blueprint.objective).not.toContain("BLUEPRINT DEPTH REQUIREMENTS")
  })

  it("does not inject a blueprint for static HTML+CSS only", () => {
    const plan = makePlan([
      makeStep("build_markup", ["tmp/index.html"]),
      makeStep("build_styles", ["tmp/styles.css"])
    ])
    expect(planNeedsCodegenBlueprint(plan)).toBe(false)
    injectBlueprintStep(plan, ".", "tmp")
    expect(plan.steps.some((s) => s.name === "generate_blueprint")).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { EMPTY_MEMORY_PER_TIER } from "../src/infra/persistence/memory/tier-context.js"
import { buildMemorySections } from "../src/runtime/prompting/system-messages/memory-sections.js"
import type { BuildContext } from "../src/runtime/prompting/system-messages/types.js"

function memoryCtx(perTier: typeof EMPTY_MEMORY_PER_TIER): BuildContext {
  return {
    opts: {
      goal: "revenue by region",
      systemPrompt: undefined,
      allTools: [],
      runWorkspace: {
        runId: "r1",
        sourceRoot: "/tmp",
        executionRoot: "/tmp",
        taskType: "analysis_or_chat",
        isolated: false,
        profile: "developer"
      },
      perTier,
      runId: "r1"
    },
    runId: "r1",
    goal: "revenue by region",
    isAdmin: false,
    hasSiblings: false,
    siblingProgressDigest: "",
    coordinationTopic: "",
    priorTurns: [],
    knownObjects: [],
    knownVerdicts: [],
    priorResults: [],
    decision: {
      includeAbiSync: false,
      includeMssqlGuidance: false,
      includeBigTableEtl: false,
      includeMssqlKnowledge: false,
      mssqlKnowledgeMode: "header",
      includeMssqlCatalog: false,
      includeChartCatalogue: false,
      includeMemoryGuidance: false,
      includeDataPersona: false
    },
    syncOperationIntent: null
  }
}

describe("buildMemorySections episodic shortcut", () => {
  it("prepends shortcut banner only when episodicShortcutEligible is true", () => {
    const eligible = buildMemorySections(
      memoryCtx({
        ...EMPTY_MEMORY_PER_TIER,
        episodic: "Goal: revenue\nStatus: completed\nAnswer: publish.Revenue",
        episodicShortcutEligible: true
      })
    )
    expect(String(eligible[0]?.content)).toContain("MEMORY HIT")

    const ineligible = buildMemorySections(
      memoryCtx({
        ...EMPTY_MEMORY_PER_TIER,
        episodic: "Goal: revenue\nStatus: completed\nAnswer: please clarify",
        episodicShortcutEligible: false
      })
    )
    expect(String(ineligible[0]?.content)).not.toContain("MEMORY HIT")
  })

  it("weaves choreography into the episodic narrative when shortcut-eligible", () => {
    const withChoreo = buildMemorySections(
      memoryCtx({
        ...EMPTY_MEMORY_PER_TIER,
        episodic:
          "Goal: revenue\nStatus: completed\nTools used: search_catalog, query_mssql (2 steps)\nAnswer: publish.Revenue",
        episodicShortcutEligible: true,
        episodicChoreography: "search_catalog → query_mssql"
      })
    )
    const content = String(withChoreo[0]?.content)
    expect(content).toContain("MEMORY HIT")
    expect(content).not.toContain("PRIOR CHOREOGRAPHY")
    expect(content).toContain("Choreography: search_catalog → query_mssql")
    expect(content.indexOf("Tools used:")).toBeLessThan(content.indexOf("Choreography:"))
    expect(content.indexOf("Choreography:")).toBeLessThan(content.indexOf("Answer:"))

    const withoutChoreo = buildMemorySections(
      memoryCtx({
        ...EMPTY_MEMORY_PER_TIER,
        episodic: "Goal: revenue\nStatus: completed\nAnswer: publish.Revenue",
        episodicShortcutEligible: true
      })
    )
    expect(String(withoutChoreo[0]?.content)).not.toContain("Choreography:")
  })
})

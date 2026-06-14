import { describe, expect, it } from "vitest"
import { EMPTY_MEMORY_PER_TIER } from "../src/platform/persistence/memory/tier-context.js"
import { buildMemorySections } from "../src/features/runs/core/system-messages/memory-sections.js"
import type { BuildContext } from "../src/features/runs/core/system-messages/types.js"

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

  it("includes choreography hint when shortcut-eligible and choreography is present", () => {
    const withChoreo = buildMemorySections(
      memoryCtx({
        ...EMPTY_MEMORY_PER_TIER,
        episodic: "Goal: revenue\nStatus: completed\nAnswer: publish.Revenue",
        episodicShortcutEligible: true,
        episodicChoreography: "search_catalog → query_mssql"
      })
    )
    expect(String(withChoreo[0]?.content)).toContain("PRIOR CHOREOGRAPHY")
    expect(String(withChoreo[0]?.content)).toContain("search_catalog → query_mssql")

    const withoutChoreo = buildMemorySections(
      memoryCtx({
        ...EMPTY_MEMORY_PER_TIER,
        episodic: "Goal: revenue",
        episodicShortcutEligible: true
      })
    )
    expect(String(withoutChoreo[0]?.content)).not.toContain("PRIOR CHOREOGRAPHY")
  })
})

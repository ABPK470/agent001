/**
 * Phase 7 guardrail: the structural SQL rules live in exactly ONE place —
 * the doctrine SSoT under packages/agent/src/doctrine/. This test makes
 * sure (a) the doctrine summaries carry the rules we removed from the
 * markdown prompts, and (b) no prompt file re-states them in detail.
 */
import { describe, expect, it } from "vitest"
import {
    assembleDoctrineBlock,
    DOCTRINE_BLOCK_BUDGET_BYTES,
    MSSQL_DOCTRINES,
} from "../src/doctrine/index.js"
import {
    ABI_SYNC_SECTION,
    BIG_TABLE_ETL_SECTION,
    CHART_CATALOGUE_SECTION,
    DEFAULT_SYSTEM_PROMPT,
    MIA_DATA_PERSONA_SECTION,
} from "../src/loop/system-prompt.js"

const ALL_PROMPTS: Array<readonly [string, string]> = [
  ["DEFAULT_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT],
  ["MIA_DATA_PERSONA_SECTION", MIA_DATA_PERSONA_SECTION],
  ["ABI_SYNC_SECTION", ABI_SYNC_SECTION],
  ["BIG_TABLE_ETL_SECTION", BIG_TABLE_ETL_SECTION],
  ["CHART_CATALOGUE_SECTION", CHART_CATALOGUE_SECTION],
]

describe("doctrine SSoT — single source of truth for MSSQL structural rules", () => {
  it("temp-naming rule lives in the doctrine, not in any prompt prose", () => {
    const tempDoctrine = MSSQL_DOCTRINES.find((d) => d.id === "mssql.temp-naming")!
    expect(tempDoctrine.summary()).toMatch(/8-hex suffix/i)
    expect(tempDoctrine.summary()).toMatch(/exactly one suffix/i)
  })

  it("big-view touch budget lives in the doctrine, not in prompt prose", () => {
    const budgetDoctrine = MSSQL_DOCTRINES.find((d) => d.id === "mssql.big-view-budget")!
    expect(budgetDoctrine.summary()).toMatch(/at most TWICE/)
  })

  it("aggregate ↔ alias rule lives in the doctrine, not in prompt prose", () => {
    const aggDoctrine = MSSQL_DOCTRINES.find((d) => d.id === "mssql.aggregate-naming")!
    expect(aggDoctrine.summary()).toMatch(/aggregate function and the output column alias MUST agree/i)
  })

  it("assembled doctrine block fits the total budget", () => {
    const block = assembleDoctrineBlock()
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(DOCTRINE_BLOCK_BUDGET_BYTES)
  })

  it("no prompt file re-states the doctrine's exact mandatory-checklist phrasing", () => {
    // Specific phrases that used to be duplicated across both temp-naming
    // doctrine and BIG_TABLE_ETL_SECTION prose. After the trim, only the
    // doctrine carries them.
    const forbiddenInPromptPhrases = [
      /find-all on every `#temp` token/i,
      /more than \*\*2×\*\* in the SQL text, rewrite into Stage 1 \+ Stage 2 \+ Stage 3/i,
    ]
    for (const [name, body] of ALL_PROMPTS) {
      for (const re of forbiddenInPromptPhrases) {
        expect(re.test(body), `${name} still re-states a doctrine rule (${re})`).toBe(false)
      }
    }
  })
})

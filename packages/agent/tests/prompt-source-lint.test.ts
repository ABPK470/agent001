/**
 * Lint-style guards on the prompt source-of-truth strings.
 *
 * These assertions are deliberately strict so that any future regression
 * (e.g. somebody pasting the chart catalogue back into
 * `DEFAULT_SYSTEM_PROMPT`, or duplicating the memory guidance into both
 * the prompt and `buildMemoryGuidance`) is caught at test time before
 * shipping.
 *
 * Numbers are absolute byte ceilings — keep them comfortably above the
 * current size so safe edits aren't penalised, but tight enough that a
 * 1 K-byte regression fails the build.
 */

import { describe, expect, it } from "vitest"
import { ABI_SYNC_SECTION, BIG_TABLE_ETL_SECTION, CHART_CATALOGUE_SECTION, DEFAULT_SYSTEM_PROMPT, MIA_DATA_PERSONA_SECTION } from "../src/application/shell/loop-cluster/system-prompt.js"

const KB = 1024

describe("prompt source-of-truth — byte ceilings", () => {
  it("DEFAULT_SYSTEM_PROMPT stays under 7 KB (slimmed; data persona lives in MIA_DATA_PERSONA_SECTION)", () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeLessThan(7 * KB)
  })

  it("MIA_DATA_PERSONA_SECTION stays under 6.5 KB", () => {
    expect(MIA_DATA_PERSONA_SECTION.length).toBeGreaterThan(2 * KB)
    expect(MIA_DATA_PERSONA_SECTION.length).toBeLessThan(6.5 * KB)
  })

  it("CHART_CATALOGUE_SECTION stays under 6 KB (current ~5 KB)", () => {
    expect(CHART_CATALOGUE_SECTION.length).toBeLessThan(6 * KB)
  })

  it("ABI_SYNC_SECTION stays under 8 KB", () => {
    expect(ABI_SYNC_SECTION.length).toBeLessThan(8 * KB)
  })

  it("BIG_TABLE_ETL_SECTION stays under 7.5 KB (canonical 2-stage pattern + anti-patterns + checklist + profile_data mode doctrine)", () => {
    expect(BIG_TABLE_ETL_SECTION.length).toBeGreaterThan(2 * KB)
    expect(BIG_TABLE_ETL_SECTION.length).toBeLessThan(7.5 * KB)
  })

  it("BIG_TABLE_ETL_SECTION teaches the must-have rules", () => {
    // Two-stage pattern (narrow keys → fetch detail rows for those keys).
    expect(BIG_TABLE_ETL_SECTION).toMatch(/STAGE\s*1/i)
    expect(BIG_TABLE_ETL_SECTION).toMatch(/STAGE\s*2/i)
    // Hard performance budget.
    expect(BIG_TABLE_ETL_SECTION).toMatch(/2\s*minutes?|120\s*s/i)
    // Unique 8-hex suffix on every #temp (collision-proof on pooled SPIDs).
    expect(BIG_TABLE_ETL_SECTION).toMatch(/8[-\s]?hex/i)
    expect(BIG_TABLE_ETL_SECTION).toMatch(/#\w+_a3f91c08/)  // example suffix appears in canonical SQL
    // Correctness traps the agent must internalise.
    expect(BIG_TABLE_ETL_SECTION).toMatch(/SUM\([^)]*Average/i)            // warns about SUM(Average…)
    expect(BIG_TABLE_ETL_SECTION).toMatch(/OUTER APPLY/i)                   // names the per-row anti-pattern
    expect(BIG_TABLE_ETL_SECTION).toMatch(/deterministic|tiebreaker/i)      // TOP n needs a tiebreaker
    // Note: the structural anti-pattern statements (find-all on every #temp,
    // ≤ 2× large-object touches) moved into the doctrine SSoT
    // (packages/agent/src/application/core/doctrine-cluster/) — see doctrine-registry tests. The prompt
    // file no longer re-states them; the validator enforces them as hard blocks.
    expect(BIG_TABLE_ETL_SECTION).toMatch(/\{\{\s*mirrorSchema\s*\}\}\.\[\{\{\s*wideUnionView\s*\}\}\]/)
    expect(BIG_TABLE_ETL_SECTION).toMatch(/Repeated scalar subqueries against the same `#detail` temp/i)
  })
})

describe("prompt source-of-truth — no duplication across blocks", () => {
  it("the chart catalogue is NOT inlined in DEFAULT_SYSTEM_PROMPT", () => {
    // The model is steered toward `get_chart_specs` for the catalogue;
    // pasting the full reference back into the system anchor would
    // double-bill every call.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("Available chart kinds (each used as the language tag")
    // A signature line from one of the chart kinds:
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("\"orientation\": \"vertical\"")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("colorScale")
  })

  it("the memory-XML guidance is NOT inlined in DEFAULT_SYSTEM_PROMPT", () => {
    // `buildMemoryGuidance()` is the single source of truth for that
    // block and is only emitted when at least one memory tier is present.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("<working_memory>")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("<episodic_memory>")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("<semantic_memory>")
  })

  it("the ABI-sync SME block is NOT inlined in DEFAULT_SYSTEM_PROMPT", () => {
    // Injected only on sync-shaped goals via decideSections.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("uspSyncContract")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("preview-first workflow")
  })

  it("the BIG_TABLE_ETL canonical example is NOT inlined in DEFAULT_SYSTEM_PROMPT", () => {
    // Only injected on data-shaped goals via decideSections.
    // A one-line reality reminder is allowed; the canonical SQL + anti-pattern list is not.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("INTO #topEntities")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("ix_detailLines")
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/Anti-patterns?\s*(to avoid|—)/i)
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/STAGE\s*1.*narrow the keys/i)
  })

  it("the MIA data persona (HARD RULES / domain anchors / number formatting) is NOT inlined in DEFAULT_SYSTEM_PROMPT", () => {
    // Persona ships only on DB/chart/sync-shaped goals via includeDataPersona.
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("HARD RULES")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("pkClient")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("Aggregate-name discipline")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("Domain anchors")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("MyMI SME")
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("33,189,259,794")
  })

  it("the persona content lives in MIA_DATA_PERSONA_SECTION", () => {
    expect(MIA_DATA_PERSONA_SECTION).toContain("HARD RULES")
    expect(MIA_DATA_PERSONA_SECTION).toMatch(/\{\{\s*keyColumnExample\s*\}\}/)
    expect(MIA_DATA_PERSONA_SECTION).toContain("MyMI SME")
  })
})

describe("prompt source-of-truth — no hardcoded tenant identifiers", () => {
  // Phase 7 of the de-hardcode refactor: customer-specific schema /
  // table / column names must NOT appear as literals in the four
  // primary prompts — they are filled at render time via
  // `renderPromptVars()` (loop/prompt-vars.ts). This guard catches
  // regressions where somebody re-introduces a `publish.Revenue`
  // example because it's familiar.
  const FORBIDDEN = /publish\.|persistedView\b|pkClient\b|pkMonth\b|pkAccount\b|pkProduct\b|pkDate\b|RevenueZAR\b|UnoTranspose\b|MappingTransactional|AfricaFlex|FrontArena|\bdim\.(?:Client|Account|Date|Product)\b|\bfact\.(?:UnoTranspose|RWA)\b/
  const PROMPTS: Array<[string, string]> = [
    ["DEFAULT_SYSTEM_PROMPT",     DEFAULT_SYSTEM_PROMPT],
    ["MIA_DATA_PERSONA_SECTION",  MIA_DATA_PERSONA_SECTION],
    ["BIG_TABLE_ETL_SECTION",     BIG_TABLE_ETL_SECTION],
    ["CHART_CATALOGUE_SECTION",   CHART_CATALOGUE_SECTION],
  ]
  for (const [name, body] of PROMPTS) {
    it(`${name} contains no customer-specific schema / table / column literals`, () => {
      const m = body.match(FORBIDDEN)
      expect(m, `forbidden token in ${name}: ${m?.[0]}`).toBeNull()
    })
  }
})

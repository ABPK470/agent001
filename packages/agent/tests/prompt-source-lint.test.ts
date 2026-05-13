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
import { ABI_SYNC_SECTION, CHART_CATALOGUE_SECTION, DEFAULT_SYSTEM_PROMPT } from "../src/loop/system-prompt.js"

const KB = 1024

describe("prompt source-of-truth — byte ceilings", () => {
  it("DEFAULT_SYSTEM_PROMPT stays under 13 KB (current ~11 KB)", () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeLessThan(13 * KB)
  })

  it("CHART_CATALOGUE_SECTION stays under 6 KB (current ~5 KB)", () => {
    expect(CHART_CATALOGUE_SECTION.length).toBeLessThan(6 * KB)
  })

  it("ABI_SYNC_SECTION stays under 8 KB", () => {
    expect(ABI_SYNC_SECTION.length).toBeLessThan(8 * KB)
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
})

/**
 * Smoke tests for `parseCoherentSolutionBundle`.
 *
 * Locks the observable JSON parse contract before the `planner/coherent` split
 * (Phase 7). These tests do NOT exercise the LLM call sites — they feed canned
 * raw strings that mimic real LLM output.
 */

import { describe, expect, it } from "vitest"
import { parseCoherentSolutionBundle } from "../src/application/core/planner.js"

describe("parseCoherentSolutionBundle smoke", () => {
  it("returns null bundle with diagnostics on non-JSON input", () => {
    const result = parseCoherentSolutionBundle("not valid json")
    expect(result.bundle).toBeNull()
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it("returns null bundle when summary is missing", () => {
    const result = parseCoherentSolutionBundle(
      JSON.stringify({
        architecture: "single page",
        artifacts: []
      })
    )
    expect(result.bundle).toBeNull()
    expect(result.diagnostics.some((d) => /summary/i.test(d))).toBe(true)
  })

  it("returns null bundle when architecture is missing", () => {
    const result = parseCoherentSolutionBundle(
      JSON.stringify({
        summary: "do a thing",
        artifacts: []
      })
    )
    expect(result.bundle).toBeNull()
    expect(result.diagnostics.some((d) => /architecture/i.test(d))).toBe(true)
  })

  it("parses a minimal valid bundle", () => {
    const raw = JSON.stringify({
      summary: "Build a counter",
      architecture: "Single React component with local state",
      artifacts: [
        {
          path: "src/Counter.tsx",
          purpose: "counter UI",
          content: "export const Counter = () => null"
        }
      ]
    })
    const result = parseCoherentSolutionBundle(raw)
    expect(result.bundle).not.toBeNull()
    expect(result.bundle?.summary).toBe("Build a counter")
    expect(result.bundle?.artifacts).toHaveLength(1)
    expect(result.bundle?.artifacts[0]?.path).toBe("src/Counter.tsx")
  })
})

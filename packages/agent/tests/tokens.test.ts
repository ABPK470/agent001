/**
 * Token estimation per-model factor sanity (Phase 0 / Gap 7).
 */
import { describe, expect, it } from "vitest"
import { charPerToken, estimateTokensFromText } from "../src/context/tokens.js"

describe("charPerToken", () => {
  it("returns 4 by default", () => {
    expect(charPerToken()).toBe(4)
    expect(charPerToken("unknown-model")).toBe(4)
  })
  it("uses 3.5 for claude/anthropic families", () => {
    expect(charPerToken("claude-3-5-sonnet")).toBe(3.5)
    expect(charPerToken("anthropic-x")).toBe(3.5)
  })
  it("uses 4 for gpt and o-series", () => {
    expect(charPerToken("gpt-4o")).toBe(4)
    expect(charPerToken("o1-mini")).toBe(4)
  })
})

describe("estimateTokensFromText", () => {
  it("returns 0 on empty", () => {
    expect(estimateTokensFromText("")).toBe(0)
  })
  it("higher chars-per-token => fewer tokens", () => {
    const text = "x".repeat(100)
    const claude = estimateTokensFromText(text, "claude-3-5-sonnet")
    const gpt = estimateTokensFromText(text, "gpt-4")
    // claude factor is 3.5 (smaller), so MORE tokens per char-count
    expect(claude).toBeGreaterThan(gpt)
  })
})

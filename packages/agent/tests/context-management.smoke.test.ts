/**
 * Smoke tests for context management (token estimation + message compaction).
 *
 * Locks the observable shape of `compactMessages` and `estimateTokens` before
 * the `context-management` split (Phase 6).
 */

import { describe, expect, it } from "vitest"
import { compactMessages, estimateTokens } from "../src/memory/index.js"
import type { Message } from "../src/domain/models/agent-types.js"

const m = (role: Message["role"], content: string, extra: Partial<Message> = {}): Message =>
  ({ role, content, ...extra }) as Message

describe("estimateTokens smoke", () => {
  it("returns 0 for an empty array", () => {
    expect(estimateTokens([])).toBe(0)
  })

  it("scales roughly with total content size", () => {
    const small = estimateTokens([m("user", "hi")])
    const big = estimateTokens([m("user", "x".repeat(4_000))])
    expect(big).toBeGreaterThan(small)
    expect(small).toBeGreaterThanOrEqual(1)
  })
})

describe("compactMessages smoke", () => {
  it("returns the input unchanged when nothing needs compacting", () => {
    const messages: Message[] = [m("system", "sys"), m("user", "hi"), m("assistant", "hello")]
    const result = compactMessages(messages)
    expect(result).toHaveLength(3)
    expect(result.map((x) => x.role)).toEqual(["system", "user", "assistant"])
  })

  it("preserves system + final user message at minimum", () => {
    const fat = "x".repeat(50_000)
    const messages: Message[] = [
      m("system", "sys"),
      m("user", fat),
      m("assistant", fat),
      m("user", fat),
      m("assistant", fat),
      m("user", "final question")
    ]
    const result = compactMessages(messages)
    expect(result[0]?.role).toBe("system")
    expect(result[result.length - 1]?.content).toBe("final question")
  })
})

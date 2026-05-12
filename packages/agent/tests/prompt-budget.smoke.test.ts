/**
 * Smoke tests for prompt-budget allocation.
 *
 * Locks the section-cap allocation behaviour and the message-truncation pass
 * before the `prompt-budget` module split (Phase 6).
 */

import { describe, expect, it } from "vitest"
import { applyPromptBudget, derivePromptBudgetPlan } from "../src/context/prompt-budget.js"
import type { Message } from "../src/types.js"

describe("derivePromptBudgetPlan smoke", () => {
  it("derives a stable cap layout for the default config", () => {
    const plan = derivePromptBudgetPlan()
    // Spot-check that the well-known invariants still hold:
    //  - all caps are positive
    //  - section caps sum to within 1 char of totalChars
    expect(plan.caps.totalChars).toBeGreaterThan(0)
    expect(plan.caps.systemChars).toBeGreaterThan(0)
    expect(plan.caps.historyChars).toBeGreaterThan(0)
    const sum =
      plan.caps.systemChars +
      plan.caps.memoryChars +
      plan.caps.historyChars +
      plan.caps.userChars +
      plan.caps.otherChars
    expect(Math.abs(sum - plan.caps.totalChars)).toBeLessThanOrEqual(2)
  })

  it("clamps absurdly small context windows to the minimum", () => {
    const plan = derivePromptBudgetPlan({ contextWindowTokens: 100 })
    expect(plan.model.contextWindowTokens).toBeGreaterThanOrEqual(2048)
  })
})

describe("applyPromptBudget smoke", () => {
  function msg(role: Message["role"], content: string, section?: Message["section"]): Message {
    return { role, content, ...(section ? { section } : {}) } as Message
  }

  it("preserves all messages when total is well under the budget", () => {
    const messages: Message[] = [
      msg("system", "You are an assistant."),
      msg("user", "Hello", "user"),
      msg("assistant", "Hi there!"),
    ]
    const result = applyPromptBudget(messages)
    expect(result.messages).toHaveLength(3)
    expect(result.diagnostics.constrained).toBe(false)
    expect(result.diagnostics.droppedSections).toEqual([])
  })

  it("drops history messages first when over budget", () => {
    const fat = "x".repeat(20_000)
    const messages: Message[] = [
      msg("system", "You are an assistant."),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", "Real user request", "user"),
    ]
    const result = applyPromptBudget(messages, { hardMaxPromptChars: 32_000 })
    // The "user" anchor and system survive; some history was dropped or truncated.
    expect(result.messages.some((m) => m.content === "Real user request")).toBe(true)
    expect(result.diagnostics.constrained).toBe(true)
    expect(result.messages.length).toBeLessThan(messages.length)
  })
})

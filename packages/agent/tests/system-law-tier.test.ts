/**
 * Phase 4: system_law tier must survive even when system_anchor would have
 * been demoted, AND multiple system_law messages must all be preserved
 * (unlike system_anchor where only the first instance keeps the tag).
 */
import { describe, expect, it } from "vitest"
import { applyPromptBudget, derivePromptBudgetPlan } from "../src/memory/index.js"
import type { Message } from "../src/domain/agent-types.js"

function msg(role: Message["role"], content: string, section?: Message["section"]): Message {
  return { role, content, ...(section ? { section } : {}) } as Message
}

describe("system_law section tier", () => {
  it("plan caps include a positive systemLawChars allocation", () => {
    const plan = derivePromptBudgetPlan()
    expect(plan.caps.systemLawChars).toBeGreaterThan(0)
    // system_law allocation must NOT come at the expense of total context.
    expect(plan.caps.systemLawChars).toBeLessThan(plan.caps.systemChars)
  })

  it("preserves multiple system_law messages under severe budget pressure", () => {
    const fat = "x".repeat(20_000)
    const messages: Message[] = [
      msg("system", "law-1: doctrine block", "system_law"),
      msg("system", "law-2: resolved facts", "system_law"),
      msg("system", "anchor-1: base prompt", "system_anchor"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", "Real user request", "user")
    ]
    const result = applyPromptBudget(messages, { hardMaxPromptChars: 24_000 })

    const lawSurvivors = result.messages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("law-")
    )
    expect(lawSurvivors).toHaveLength(2)
    // and the last user message is also preserved
    expect(result.messages.some((m) => m.content === "Real user request")).toBe(true)
  })

  it("system_law is not in the droppable sections list", async () => {
    const { SECTION_BEHAVIOR } = await import("../src/memory/prompt-budget-types.js")
    expect(SECTION_BEHAVIOR["system_law"].dropAllowed).toBe(false)
  })
})

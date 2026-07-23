import { describe, expect, it } from "vitest"
import { classifyUserFacingFailure } from "../src/core/plan/user-facing-failure.js"
import { synthesizeGenericFailureAnswer } from "../src/core/plan/platform-errors.js"

describe("classifyUserFacingFailure", () => {
  it("explains Databricks / provider rate limits in plain language", () => {
    const hit = {
      kind: "task_failed",
      summary: "Task verification FAILED",
      rawDetail:
        "Task verification FAILED — issues remain\n\n⚠ analyze (subagent_task): incomplete\n  ⚠ Delegation failed: Databricks API error 429: request limit exceeded"
    }
    const classified = classifyUserFacingFailure(hit)
    expect(classified.kind).toBe("rate_limited")
    expect(classified.userReason.toLowerCase()).toMatch(/rate limit|try again/)
  })

  it("surfaces the first verification issue when present", () => {
    const hit = {
      kind: "task_failed",
      summary: "Task verification FAILED",
      rawDetail:
        "Task verification FAILED\n\n⚠ write_answer (subagent_task): incomplete\n  ! Missing adjusted client offer narrative"
    }
    const classified = classifyUserFacingFailure(hit)
    expect(classified.kind).toBe("verification_failed")
    expect(classified.userReason).toContain("Missing adjusted client offer narrative")
  })
})

describe("synthesizeGenericFailureAnswer", () => {
  it("includes the classified reason instead of a blank something-went-wrong", () => {
    const answer = synthesizeGenericFailureAnswer(
      "The AI service hit a temporary rate limit while working on this request. Please try again in a moment."
    )
    expect(answer).toContain("couldn’t be completed")
    expect(answer).toContain("rate limit")
    expect(answer).toContain("{RUN_REF}")
  })
})

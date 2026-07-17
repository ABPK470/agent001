import { describe, expect, it } from "vitest"
import { ApprovalRequiredError } from "../src/domain/index.js"
import { executeToolWithTimeout } from "../src/tools/_shared/utils/exec-with-timeout.js"

describe("executeToolWithTimeout", () => {
  it("re-throws ApprovalRequiredError instead of treating it as a tool failure", async () => {
    const err = new ApprovalRequiredError(
      "run-1",
      "step-1",
      "ask_user",
      { question: "Continue?" },
      "needs approval",
      "policy"
    )

    await expect(
      executeToolWithTimeout(
        "ask_user",
        { question: "Continue?" },
        async () => {
          throw err
        },
        { toolCallTimeoutMs: 0, maxRetries: 0 }
      )
    ).rejects.toBe(err)
  })
})

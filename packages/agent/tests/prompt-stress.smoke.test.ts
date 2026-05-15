/**
 * Prompt diet stress smoke test (Gap 12).
 *
 * Synthesizes 50 iterations of a synthetic agent run with progressively
 * larger tool-result payloads (1KB → 1MB) and asserts that the prompt
 * stays bounded after compaction + truncation.
 *
 * Opt-in: gated by MIA_RUN_STRESS=1 so it doesn't slow CI.
 */

import { describe, expect, it } from "vitest"
import { compactMessages, truncateMessages } from "../src/context/index.js"
import { estimateTokensFromMessages } from "../src/context/tokens.js"
import { MessageRole } from "../src/domain/enums/message.js"
import type { Message } from "../src/types.js"

const ENABLED = process.env.MIA_RUN_STRESS === "1"

const describeMaybe = ENABLED ? describe : describe.skip

describeMaybe("prompt diet stress (50-iteration synthetic run)", () => {
  it("keeps prompt < 100K tokens across escalating payload sizes", () => {
    const messages: Message[] = [
      { role: MessageRole.System, content: "You are a test agent.", section: "system_anchor" },
      { role: MessageRole.User, content: "synthetic stress goal", section: "user" },
    ]

    const tokensPerCall: number[] = []

    for (let i = 0; i < 50; i++) {
      // Payload doubles every 5 iterations: 1K, 2K, 4K, ..., up to ~1MB
      const size = Math.min(1_000_000, 1024 * 2 ** Math.floor(i / 5))
      const payload = "X".repeat(size)

      messages.push({
        role: MessageRole.Assistant,
        content: `Iteration ${i} reasoning.`,
        toolCalls: [{ id: `call-${i}`, name: "read_file", arguments: { path: `/tmp/f${i}.txt` } }],
        section: "history",
      })
      messages.push({
        role: MessageRole.Tool,
        content: payload,
        toolCallId: `call-${i}`,
        section: "history",
      })

      const compacted = compactMessages(messages)
      const truncated = truncateMessages(compacted, "gpt-4")
      const tokens = estimateTokensFromMessages(truncated.messages, "gpt-4")
      tokensPerCall.push(tokens)
      // Hard ceiling — 100K tokens leaves 100K of headroom on a
      // 200K-context model for the response itself.
      expect(tokens).toBeLessThan(100_000)
    }

    // Average call should be much smaller than the worst-case bound.
    const avg = tokensPerCall.reduce((s, n) => s + n, 0) / tokensPerCall.length
    expect(avg).toBeLessThan(80_000)
  })
})

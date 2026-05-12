/**
 * Smoke tests for recovery hint inference.
 *
 * Locks current observable behaviour of `buildRecoveryHints` for a handful of
 * representative tool-call records. These snapshots protect the upcoming
 * `recovery-*` module split (Phase 6) from accidental drift.
 */

import { describe, expect, it } from "vitest"
import { buildRecoveryHints, type ToolCallRecord } from "../src/recovery.js"

function call(over: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    name: "run_command",
    args: {},
    result: "",
    isError: false,
    ...over,
  }
}

describe("buildRecoveryHints smoke", () => {
  it("emits ENOENT hint when a tool result mentions missing file", () => {
    const hints = buildRecoveryHints(
      [call({ isError: true, result: "Error: ENOENT: no such file or directory, open '/missing/path.txt'" })],
      new Set(),
    )
    expect(hints).toHaveLength(1)
    // The current ENOENT regex captures the next word after "directory," — snapshot
    // whatever today's behaviour is so the upcoming module split can't drift it.
    expect(hints[0]?.key).toMatchInlineSnapshot(`"enoent:open"`)
    expect(hints[0]?.message.length).toBeGreaterThan(0)
  })

  it("emits all-failed hint when every call in a round failed", () => {
    const hints = buildRecoveryHints(
      [
        call({ isError: true, result: "error: connection refused" }),
        call({ isError: true, result: "error: command not found" }),
      ],
      new Set(),
    )
    expect(hints.some((h) => h.key === "round-all-tools-failed")).toBe(true)
  })

  it("emits delegation-exhausted hint when child agent ran out of budget", () => {
    const hints = buildRecoveryHints(
      [call({ name: "delegate", result: "Agent stopped after 30 iterations without completing the task." })],
      new Set(),
    )
    expect(hints.some((h) => h.key === "delegation-child-exhausted-budget")).toBe(true)
  })

  it("respects the emittedHints dedup set", () => {
    const emitted = new Set<string>(["enoent:open"])
    const hints = buildRecoveryHints(
      [call({ isError: true, result: "Error: ENOENT: no such file or directory, open '/missing/path.txt'" })],
      emitted,
    )
    expect(hints).toHaveLength(0)
  })

  it("returns no hints when nothing matched", () => {
    const hints = buildRecoveryHints([call({ result: "ok\n" })], new Set())
    expect(hints).toEqual([])
  })
})

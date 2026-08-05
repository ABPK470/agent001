import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  planRevealRunInTranscript,
  planTranscriptReveal,
} from "./revealRunInTranscript"

describe("planRevealRunInTranscript", () => {
  it("returns null when the run is not in the transcript yet", () => {
    expect(planRevealRunInTranscript([{ id: "r1" }], "r2")).toBeNull()
    expect(planRevealRunInTranscript([], "r1")).toBeNull()
  })

  it("reveals the second (latest) run by index — never skip because it is latest", () => {
    const runs = [{ id: "r1" }, { id: "r2" }]
    // Regression: jump effect used to return early when active === latest,
    // so VirtualList never scrollToIndex'd the new goal turn.
    expect(planRevealRunInTranscript(runs, "r2")).toEqual({ index: 1, align: "end" })
    expect(planRevealRunInTranscript(runs, "r1")).toEqual({ index: 0, align: "end" })
  })

  it("targets the last index after many prior turns (virtual window miss)", () => {
    const runs = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }))
    expect(planRevealRunInTranscript(runs, "r24")).toEqual({ index: 24, align: "end" })
  })
})

describe("planTranscriptReveal", () => {
  it("routes the live Zone B turn without a VirtualList index", () => {
    expect(planTranscriptReveal([{ id: "r1" }], "r2", "r2")).toEqual({ kind: "live" })
  })

  it("routes settled history by VirtualList index", () => {
    expect(planTranscriptReveal([{ id: "r1" }], "r2", "r1")).toEqual({
      kind: "settled",
      index: 0,
      align: "end",
    })
  })
})

describe("TermChat second-goal reveal contract", () => {
  const termChat = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "TermChat.tsx"),
    "utf8",
  )

  it("reveals via planTranscriptReveal — live pin or settled scrollToIndex", () => {
    expect(termChat).toContain("planTranscriptReveal")
    expect(termChat).toContain("setScrollToRunId(runId)")
    expect(termChat).toContain("settledRuns")
    expect(termChat).toContain("chat-transcript-live-turn")
    expect(termChat).toMatch(/scrollToIndex\(reveal\.index/)
    // Must not only stick via scrollHeight after start (misses unmounted latest turn).
    expect(termChat).not.toMatch(
      /setScrollToRunId\(runId\)\s*\n\s*requestAnimationFrame\(\(\) => scrollToBottom/,
    )
  })
})

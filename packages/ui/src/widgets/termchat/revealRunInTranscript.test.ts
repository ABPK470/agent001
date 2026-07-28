import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { planRevealRunInTranscript } from "./revealRunInTranscript"

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

describe("TermChat second-goal reveal contract", () => {
  const termChat = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "TermChat.tsx"),
    "utf8",
  )

  it("reveals new runs via planRevealRunInTranscript + VirtualList scrollToIndex", () => {
    expect(termChat).toContain("planRevealRunInTranscript")
    expect(termChat).toContain("setScrollToRunId(runId)")
    expect(termChat).toMatch(/scrollToIndex\(plan\.index/)
    // Must not only stick via scrollHeight after start (misses unmounted latest turn).
    expect(termChat).not.toMatch(
      /setScrollToRunId\(runId\)\s*\n\s*requestAnimationFrame\(\(\) => scrollToBottom/,
    )
  })
})

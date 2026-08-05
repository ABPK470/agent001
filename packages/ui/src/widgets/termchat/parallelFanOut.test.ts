import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { ResponsePart, ResponseStepBlockPart } from "../../lib/events/build-chat-parts.js"
import {
  countRunningSubagentSteps,
  firstRunningSubagentStepId,
  isParallelSubagentFanOut,
} from "./parallelFanOut.js"

const here = dirname(fileURLToPath(import.meta.url))

function step(
  id: string,
  opts: { subagent?: boolean; hasRunning?: boolean } = {},
): ResponseStepBlockPart {
  return {
    kind: "step-block",
    id,
    title: id,
    status: opts.hasRunning ? "running" : "done",
    subagent: opts.subagent,
    tools: [],
    hasRunning: Boolean(opts.hasRunning),
  }
}

describe("parallelFanOut", () => {
  it("counts only live subagent step-blocks", () => {
    const parts: ResponsePart[] = [
      step("a", { subagent: true, hasRunning: true }),
      step("b", { subagent: true, hasRunning: true }),
      step("c", { subagent: true, hasRunning: false }),
      step("d", { hasRunning: true }),
    ]
    expect(countRunningSubagentSteps(parts)).toBe(2)
    expect(isParallelSubagentFanOut(parts)).toBe(true)
    expect(firstRunningSubagentStepId(parts)).toBe("a")
  })

  it("is not fan-out for a single running subagent", () => {
    const parts: ResponsePart[] = [step("only", { subagent: true, hasRunning: true })]
    expect(countRunningSubagentSteps(parts)).toBe(1)
    expect(isParallelSubagentFanOut(parts)).toBe(false)
  })

  it("is not fan-out when nothing is running", () => {
    const parts: ResponsePart[] = [
      step("a", { subagent: true, hasRunning: false }),
      step("b", { subagent: true, hasRunning: false }),
    ]
    expect(isParallelSubagentFanOut(parts)).toBe(false)
    expect(firstRunningSubagentStepId(parts)).toBeNull()
  })

  it("chat must not park the host on fan-out (watching user stays put)", () => {
    const term = readFileSync(join(here, "../TermChat.tsx"), "utf8")
    const mod = readFileSync(join(here, "parallelFanOut.ts"), "utf8")
    expect(term).not.toContain("scrollStepToHostTop")
    expect(term).not.toContain("firstRunningSubagentStepId")
    expect(mod).not.toContain("scrollStepToHostTop")
  })

  it("keeps finished siblings open only during true parallel fan-out", () => {
    const term = readFileSync(join(here, "../TermChat.tsx"), "utf8")
    // Sequential planner must not treat "any subagent running" as fan-out.
    expect(term).not.toContain("anySubagentRunning")
    expect(term).toContain("isParallelSubagentFanOut(responseParts)")
    expect(term).toContain("keepParallelSiblingsOpen")
  })
})

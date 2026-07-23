import { describe, expect, it } from "vitest"
import type {
  ResponsePart,
  ResponseProgressPart,
  ResponseToolPart,
} from "../../lib/events/build-chat-parts.js"
import {
  canElementScrollVertically,
  deriveActiveMilestoneLabel,
  formatDeliverableBytes,
  isOffThreadProgress,
  liveActivityVerb,
  summarizeHistory,
  summarizeRunError,
} from "./milestone.js"

function progress(
  id: string,
  status: ResponseProgressPart["status"] = "running",
  extra: Partial<ResponseProgressPart> = {},
): ResponseProgressPart {
  return { kind: "progress", id, label: id, status, ...extra }
}

function tool(
  name: string,
  status: ResponseToolPart["row"]["status"] = "running",
): ResponseToolPart {
  return {
    kind: "tool",
    id: `t-${name}`,
    row: { id: `t-${name}`, tool: name, summary: name, status },
  }
}

describe("isOffThreadProgress", () => {
  it("hides routing/thinking/pipeline/plan from the transcript", () => {
    expect(isOffThreadProgress(progress("direct"))).toBe(true)
    expect(isOffThreadProgress(progress("plan"))).toBe(true)
    expect(isOffThreadProgress(progress("thinking"))).toBe(true)
    expect(isOffThreadProgress(progress("pipeline-plan"))).toBe(true)
    expect(isOffThreadProgress(progress("step-frontend"))).toBe(false)
  })
})

describe("liveActivityVerb / deriveActiveMilestoneLabel", () => {
  it("maps known tools to coarse shimmer verbs", () => {
    expect(liveActivityVerb("query_mssql")).toBe("Executing")
    expect(liveActivityVerb("write_file")).toBe("Writing")
    expect(liveActivityVerb("mystery_tool")).toBe("Working")
  })

  it("prefers running tool verb over thinking", () => {
    const parts: ResponsePart[] = [
      progress("thinking"),
      tool("query_mssql", "running"),
    ]
    expect(deriveActiveMilestoneLabel(parts)).toBe("Executing")
  })

  it("reads running tools inside iteration blocks", () => {
    const parts: ResponsePart[] = [
      {
        kind: "iteration-block",
        id: "iter-1",
        summary: "Ran write_file",
        hasRunning: true,
        tools: [tool("write_file", "running")],
      },
    ]
    expect(deriveActiveMilestoneLabel(parts)).toBe("Writing")
  })

  it("reads running tools inside step-blocks (plan route parity)", () => {
    const parts: ResponsePart[] = [
      {
        kind: "step-block",
        id: "step-1",
        title: "Subagent · Generate blueprint",
        hasRunning: true,
        subagent: true,
        tools: [tool("write_file", "running")],
        status: "running",
      },
    ]
    expect(deriveActiveMilestoneLabel(parts)).toBe("Writing")
  })

  it("uses verbose plan labels for shimmer, never bare Plan", () => {
    expect(
      deriveActiveMilestoneLabel([
        progress("direct"),
        progress("thinking", "running", { label: "Thinking" }),
      ]),
    ).toBe("Thinking")
    expect(
      deriveActiveMilestoneLabel([
        { ...progress("plan"), label: "Generating plan…" },
      ]),
    ).toBe("Generating plan…")
  })

  it("never echoes step-block titles in the shimmer", () => {
    expect(
      deriveActiveMilestoneLabel([
        {
          kind: "step-block",
          id: "step-1",
          title: "Subagent · Generate blueprint",
          detail: "writing pages",
          hasRunning: true,
          subagent: true,
          tools: [],
          status: "running",
        },
      ]),
    ).toBe("Delegating")
    expect(
      deriveActiveMilestoneLabel([
        {
          kind: "step-block",
          id: "step-2",
          title: "Frontend layer",
          hasRunning: true,
          tools: [],
          status: "running",
        },
      ]),
    ).toBe("Working")
  })

  it("names parallel fan-out when several subagents are running", () => {
    expect(
      deriveActiveMilestoneLabel([
        {
          kind: "step-block",
          id: "a",
          title: "Subagent · Frontend",
          hasRunning: true,
          subagent: true,
          tools: [],
          status: "running",
        },
        {
          kind: "step-block",
          id: "b",
          title: "Subagent · Api",
          hasRunning: true,
          subagent: true,
          tools: [],
          status: "running",
        },
      ]),
    ).toBe("2 subagents")
  })

  it("keeps parallel fan-out visible even after one child starts tooling", () => {
    expect(
      deriveActiveMilestoneLabel([
        {
          kind: "step-block",
          id: "a",
          title: "Subagent · Frontend",
          hasRunning: true,
          subagent: true,
          tools: [tool("search_catalog", "running")],
          status: "running",
        },
        {
          kind: "step-block",
          id: "b",
          title: "Subagent · Api",
          hasRunning: true,
          subagent: true,
          tools: [],
          status: "running",
        },
      ]),
    ).toBe("2 subagents · Searching")
  })
})

describe("summarizeHistory / summarizeRunError / bytes", () => {
  it("summarizes tool history without leading I", () => {
    const summary = summarizeHistory([
      tool("read_file", "done"),
      tool("write_file", "done"),
    ])
    expect(summary.startsWith("I ")).toBe(false)
    expect(summary.length).toBeGreaterThan(0)
  })

  it("falls back to last progress label", () => {
    expect(summarizeHistory([progress("generation", "done", { label: "Writing" })])).toBe(
      "Writing",
    )
    expect(summarizeHistory([])).toBe("Technical flow")
  })

  it("softens Copilot auth failures", () => {
    const r = summarizeRunError("Device flow timed out")
    expect(r.summary).toMatch(/re-authorize/i)
    expect(r.details).toBe("Device flow timed out")
  })

  it("shortens long/JSON errors", () => {
    const long = `Boom\n${"x".repeat(300)}`
    const r = summarizeRunError(long)
    expect(r.summary.length).toBeLessThanOrEqual(181)
    expect(r.details).toBe(long)
  })

  it("formats deliverable sizes", () => {
    expect(formatDeliverableBytes(500)).toBe("500 B")
    expect(formatDeliverableBytes(2048)).toBe("2.0 KB")
    expect(formatDeliverableBytes(2 * 1024 * 1024)).toBe("2.0 MB")
  })

  it("detects nested scroll capacity", () => {
    const el = { scrollHeight: 200, clientHeight: 100, scrollTop: 0 }
    expect(canElementScrollVertically(el, 10)).toBe(true)
    expect(canElementScrollVertically(el, -10)).toBe(false)
    el.scrollTop = 50
    expect(canElementScrollVertically(el, -10)).toBe(true)
    expect(canElementScrollVertically({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }, 10)).toBe(
      false,
    )
  })
})

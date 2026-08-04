import { describe, expect, it } from "vitest"
import {
  buildTimelineOffsets,
  parseEventMs,
  timelineEventDisplayText,
  timelineEventKind,
  timelinePhaseOutcome,
} from "./trace-phase-timeline-utils"

describe("parseEventMs", () => {
  it("extracts ms from finished lines", () => {
    expect(parseEventMs("Finished · 2288ms")).toBe(2288)
    expect(parseEventMs("execution -> running (attempt 1)")).toBeNull()
  })
})

describe("timelinePhaseOutcome", () => {
  it("treats branch errors as failed even when phase text says done", () => {
    expect(
      timelinePhaseOutcome({
        phaseStatus: "done",
        nodeStatus: "success",
        nodeHasError: false,
        branchHasError: true,
      }),
    ).toBe("failed")
  })

  it("is success only when phase and tree agree", () => {
    expect(
      timelinePhaseOutcome({
        phaseStatus: "done",
        nodeStatus: "success",
        nodeHasError: false,
        branchHasError: false,
      }),
    ).toBe("success")
  })
})

describe("timelineEventKind", () => {
  it("classifies tools and successful completion", () => {
    expect(timelineEventKind("Tools: write_file, read_file", undefined, false, "success")).toBe(
      "tools",
    )
    expect(timelineEventKind("Finished · 400ms", undefined, true, "success")).toBe("complete")
    expect(timelineEventKind("Subagent started", undefined, false, "running")).toBe("neutral")
    expect(timelineEventKind("rate limited", "warn", false, "running")).toBe("warn")
  })

  it("does not greenwash Finished when the phase/tree failed", () => {
    expect(timelineEventKind("Finished · 1800ms", undefined, true, "failed")).toBe("error")
    expect(
      timelineEventKind("Finished 4/4 steps (success)", undefined, true, "failed"),
    ).toBe("error")
  })
})

describe("timelineEventDisplayText", () => {
  it("rewrites completion copy for failed outcomes", () => {
    expect(timelineEventDisplayText("Finished · 1800ms", "failed")).toBe("Failed · 1800ms")
    expect(timelineEventDisplayText("Finished 4/4 steps (success)", "failed")).toBe(
      "Finished 4/4 steps (failed)",
    )
    expect(timelineEventDisplayText("Finished · 1800ms", "success")).toBe("Finished · 1800ms")
  })
})

describe("buildTimelineOffsets", () => {
  it("interpolates when phase duration is known", () => {
    const events = [
      { text: "Subagent started" },
      { text: "Blueprint pages" },
      { text: "Finished · 400ms" },
    ]
    expect(buildTimelineOffsets(events, 400)).toEqual([0, 200, 400])
  })

  it("uses parsed ms from event text", () => {
    const events = [{ text: "Finished · 2288ms" }]
    expect(buildTimelineOffsets(events, 400)).toEqual([2288])
  })
})

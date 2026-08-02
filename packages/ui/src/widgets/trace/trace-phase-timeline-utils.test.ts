import { describe, expect, it } from "vitest"
import {
  buildTimelineOffsets,
  parseEventMs,
  timelineEventKind,
} from "./trace-phase-timeline-utils"

describe("parseEventMs", () => {
  it("extracts ms from finished lines", () => {
    expect(parseEventMs("Finished · 2288ms")).toBe(2288)
    expect(parseEventMs("execution -> running (attempt 1)")).toBeNull()
  })
})

describe("timelineEventKind", () => {
  it("classifies tools and completion", () => {
    expect(timelineEventKind("Tools: write_file, read_file", undefined, false, true)).toBe("tools")
    expect(timelineEventKind("Finished · 400ms", undefined, true, true)).toBe("complete")
    expect(timelineEventKind("Subagent started", undefined, false, false)).toBe("neutral")
    expect(timelineEventKind("rate limited", "warn", false, false)).toBe("warn")
  })
})

describe("buildTimelineOffsets", () => {
  it("interpolates when phase duration is known", () => {
    const events = [{ text: "Subagent started" }, { text: "Blueprint pages" }, { text: "Finished · 400ms" }]
    expect(buildTimelineOffsets(events, 400)).toEqual([0, 200, 400])
  })

  it("uses parsed ms from event text", () => {
    const events = [{ text: "Finished · 2288ms" }]
    expect(buildTimelineOffsets(events, 400)).toEqual([2288])
  })
})

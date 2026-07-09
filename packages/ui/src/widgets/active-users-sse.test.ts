import { EventType } from "@mia/shared-enums"
import { describe, expect, it } from "vitest"
import {
  isActiveRunLiveEvent,
  isActiveRunStepEvent,
  isHistoryRefreshEvent,
  isSummaryRefreshEvent,
} from "./active-users-sse"

describe("active-users-sse", () => {
  it("summary refresh reacts to run lifecycle and presence tick only", () => {
    expect(isSummaryRefreshEvent(EventType.RunStarted)).toBe(true)
    expect(isSummaryRefreshEvent(EventType.SessionPresenceTick)).toBe(true)
    expect(isSummaryRefreshEvent(EventType.StepCompleted)).toBe(false)
    expect(isSummaryRefreshEvent("sync.proposal.created")).toBe(false)
  })

  it("history refresh ignores presence tick and step events", () => {
    expect(isHistoryRefreshEvent(EventType.RunCompleted)).toBe(true)
    expect(isHistoryRefreshEvent(EventType.RunStarted)).toBe(false)
    expect(isHistoryRefreshEvent(EventType.SessionPresenceTick)).toBe(false)
    expect(isHistoryRefreshEvent(EventType.StepCompleted)).toBe(false)
  })

  it("active run live events cover lifecycle but not steps", () => {
    expect(isActiveRunLiveEvent(EventType.RunStarted)).toBe(true)
    expect(isActiveRunStepEvent(EventType.StepCompleted)).toBe(true)
    expect(isActiveRunLiveEvent(EventType.StepCompleted)).toBe(false)
  })
})

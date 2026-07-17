import { EventType } from "@mia/shared-enums"
import { describe, expect, it } from "vitest"

import { isOperationLogEvent } from "../src/api/operations/application/query/operation-log-events.js"

describe("isOperationLogEvent", () => {
  it("includes run, sync, and step lifecycle events", () => {
    expect(isOperationLogEvent(EventType.RunStarted)).toBe(true)
    expect(isOperationLogEvent(EventType.SyncExecuteStep)).toBe(true)
    expect(isOperationLogEvent(EventType.StepCompleted)).toBe(true)
  })

  it("ignores high-frequency non-operation noise", () => {
    expect(isOperationLogEvent(EventType.DebugTrace)).toBe(false)
    expect(isOperationLogEvent(EventType.AnswerChunk)).toBe(false)
    expect(isOperationLogEvent(EventType.SessionPresenceTick)).toBe(false)
    expect(isOperationLogEvent(EventType.UsageUpdated)).toBe(false)
  })
})

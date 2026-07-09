import { describe, expect, it } from "vitest"

import { readSseStepId } from "@mia/shared-types"

import {
  traceEntryFromStepCompleted,
  traceEntryFromStepStarted,
} from "./sse-run-trace.js"

describe("sse step trace entries", () => {
  it("pairs tool-call and tool-result on invocationId during live SSE", () => {
    const started = traceEntryFromStepStarted({
      stepId: "inv-1",
      action: "query_mssql",
      input: { query: "SELECT 1" },
    })
    const completed = traceEntryFromStepCompleted({
      stepId: "inv-1",
      output: { result: "1 row" },
    })
    expect(started?.kind).toBe("tool-call")
    expect(started?.invocationId).toBe("inv-1")
    expect(completed?.kind).toBe("tool-result")
    expect(completed?.invocationId).toBe("inv-1")
    expect(completed?.text).toBe("1 row")
  })

  it("returns null when wire stepId is missing", () => {
    expect(traceEntryFromStepStarted({ action: "query_mssql", input: {} })).toBeNull()
    expect(traceEntryFromStepCompleted({ output: { result: "x" } })).toBeNull()
    expect(readSseStepId({ "step-id": "not-sse" })).toBeUndefined()
  })
})

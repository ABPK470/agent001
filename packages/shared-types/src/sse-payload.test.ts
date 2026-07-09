import { describe, expect, it } from "vitest"

import {
  readSseEntityId,
  readSseRunId,
  readSseStepId,
  readToolEntityId,
  sseStepDedupeToken
} from "./sse-payload.js"

describe("SSE payload accessors", () => {
  it("reads stepId (camelCase wire field)", () => {
    expect(readSseStepId({ stepId: "step-abc" })).toBe("step-abc")
  })

  it("does not treat catalog kebab-case ids as SSE step fields", () => {
    expect(readSseStepId({ "step-id": "catalog-resolver-id" })).toBeUndefined()
  })

  it("reads runId and builds dedupe token", () => {
    expect(readSseRunId({ runId: "run-1" })).toBe("run-1")
    expect(sseStepDedupeToken({ stepId: "s1" })).toBe("s1")
  })

  it("reads entityId from SSE payloads (string or number)", () => {
    expect(readSseEntityId({ entityId: "4368" })).toBe("4368")
    expect(readSseEntityId({ entityId: 4368 })).toBe("4368")
  })

  it("does not treat catalog entity-id key as SSE entityId", () => {
    expect(readSseEntityId({ "entity-id": "4368" })).toBeUndefined()
  })

  it("reads entityId from tool args", () => {
    expect(readToolEntityId({ entityId: 42 })).toBe("42")
    expect(readToolEntityId({ "entity-id": 42 })).toBe("")
  })
})

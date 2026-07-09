import { describe, expect, it } from "vitest"

import type { SyncExecuteProgress } from "../../types"
import { execAuditLogEvents, isExecAuditLogEvent } from "./exec-log-events.js"

describe("exec-log-events", () => {
  it("drops in-flight deploy-step ticks", () => {
    const started: SyncExecuteProgress = {
      type: "deploy-step",
      step: "pipelineRegister",
      deployStatus: "started",
      message: "Register the target pipeline with the agent service."
    }
    const done: SyncExecuteProgress = {
      type: "deploy-step",
      step: "pipelineRegister",
      deployStatus: "done",
      message: "Register the target pipeline with the agent service."
    }

    expect(isExecAuditLogEvent(started)).toBe(false)
    expect(isExecAuditLogEvent(done)).toBe(true)
    expect(execAuditLogEvents([started, done])).toEqual([done])
  })

  it("keeps metadata table lifecycle rows", () => {
    const upsert: SyncExecuteProgress = { type: "table-done", table: "core.Activity", rowsApplied: 4 }
    const deletePass: SyncExecuteProgress = { type: "table-done", table: "core.Activity", rowsApplied: 0 }
    expect(execAuditLogEvents([upsert, deletePass])).toEqual([upsert, deletePass])
  })
})

/**
 * Compatibility tests — helpers live in @mia/shared-types; UI re-exports them.
 */
import { describe, expect, it } from "vitest"
import { RunStatus } from "../enums"
import {
  canCancelRun,
  canResumeRun,
  canRollbackRun,
} from "./run-actions"

describe("run-actions re-export", () => {
  it("exposes platform capability gates", () => {
    expect(canCancelRun(RunStatus.WaitingForApproval)).toBe(true)
    expect(canResumeRun(RunStatus.Failed, true)).toBe(true)
    expect(canResumeRun(RunStatus.Failed, false)).toBe(false)
    expect(canRollbackRun(RunStatus.Completed, { rollbackAvailable: true })).toBe(true)
    expect(canRollbackRun(RunStatus.Completed, { rollbackAvailable: false })).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { RunStatus } from "../enums"
import {
  canCancelRun,
  canConfirmRollback,
  canResumeRun,
  canRollbackRun,
} from "./run-actions"
import type { RollbackPreview } from "../types"

describe("canCancelRun", () => {
  it("allows live and waiting_for_approval", () => {
    expect(canCancelRun(RunStatus.Running)).toBe(true)
    expect(canCancelRun(RunStatus.Pending)).toBe(true)
    expect(canCancelRun(RunStatus.Planning)).toBe(true)
    expect(canCancelRun(RunStatus.WaitingForApproval)).toBe(true)
  })

  it("rejects terminal statuses", () => {
    expect(canCancelRun(RunStatus.Completed)).toBe(false)
    expect(canCancelRun(RunStatus.Failed)).toBe(false)
    expect(canCancelRun(RunStatus.Cancelled)).toBe(false)
  })
})

describe("canResumeRun", () => {
  it("requires terminal failure and a checkpoint", () => {
    expect(canResumeRun(RunStatus.Failed, true)).toBe(true)
    expect(canResumeRun(RunStatus.Cancelled, true)).toBe(true)
    expect(canResumeRun(RunStatus.Crashed, true)).toBe(true)
  })

  it("hides resume without a checkpoint or when still live", () => {
    expect(canResumeRun(RunStatus.Failed, false)).toBe(false)
    expect(canResumeRun(RunStatus.Failed, undefined)).toBe(false)
    expect(canResumeRun(RunStatus.Completed, true)).toBe(false)
    expect(canResumeRun(RunStatus.Running, true)).toBe(false)
  })
})

describe("canRollbackRun", () => {
  it("shows only when server reports uncompensated effects", () => {
    expect(canRollbackRun(RunStatus.Completed, {
      rollbackAvailable: true,
      alreadyRolledBack: false,
    })).toBe(true)
    expect(canRollbackRun(RunStatus.Failed, {
      rollbackAvailable: true,
      alreadyRolledBack: false,
    })).toBe(true)
  })

  it("hides when nothing to roll back or already rolled back", () => {
    expect(canRollbackRun(RunStatus.Completed, {
      rollbackAvailable: false,
      alreadyRolledBack: false,
    })).toBe(false)
    expect(canRollbackRun(RunStatus.Completed, {
      rollbackAvailable: undefined,
      alreadyRolledBack: false,
    })).toBe(false)
    expect(canRollbackRun(RunStatus.Completed, {
      rollbackAvailable: true,
      alreadyRolledBack: true,
    })).toBe(false)
    expect(canRollbackRun(RunStatus.Running, {
      rollbackAvailable: true,
      alreadyRolledBack: false,
    })).toBe(false)
  })
})

describe("canConfirmRollback", () => {
  const empty: RollbackPreview = {
    wouldCompensate: [],
    wouldSkip: [],
    wouldFail: [],
  }

  it("requires work and no blockers", () => {
    expect(canConfirmRollback(empty)).toBe(false)
    expect(canConfirmRollback({
      ...empty,
      wouldCompensate: [{ effectId: "e1", kind: "create", target: "/a.ts", hasSnapshot: true }],
    })).toBe(true)
    expect(canConfirmRollback({
      ...empty,
      wouldCompensate: [{ effectId: "e1", kind: "create", target: "/a.ts", hasSnapshot: true }],
      wouldFail: [{ effectId: "e2", target: "/b.ts", reason: "conflict" }],
    })).toBe(false)
  })
})

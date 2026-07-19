import { describe, expect, it } from "vitest"
import { RunStatus } from "@mia/shared-enums"
import {
  canCancelRun,
  canConfirmRollback,
  canResumeRun,
  canRollbackRun,
  isRunCapabilityActionAllowed,
} from "./run-capabilities.js"

describe("canCancelRun", () => {
  it("allows live and waiting_for_approval", () => {
    expect(canCancelRun(RunStatus.Running)).toBe(true)
    expect(canCancelRun(RunStatus.WaitingForApproval)).toBe(true)
  })

  it("rejects terminal statuses", () => {
    expect(canCancelRun(RunStatus.Completed)).toBe(false)
    expect(canCancelRun(RunStatus.Failed)).toBe(false)
  })
})

describe("canResumeRun", () => {
  it("requires terminal failure and a checkpoint", () => {
    expect(canResumeRun(RunStatus.Failed, true)).toBe(true)
    expect(canResumeRun(RunStatus.Cancelled, true)).toBe(true)
    expect(canResumeRun(RunStatus.Crashed, true)).toBe(true)
    expect(canResumeRun(RunStatus.Failed, false)).toBe(false)
    expect(canResumeRun(RunStatus.Failed, undefined)).toBe(false)
    expect(canResumeRun(RunStatus.Completed, true)).toBe(false)
  })
})

describe("canRollbackRun", () => {
  it("shows only when uncompensated effects remain", () => {
    expect(canRollbackRun(RunStatus.Completed, { rollbackAvailable: true })).toBe(true)
    expect(canRollbackRun(RunStatus.Failed, { rollbackAvailable: true })).toBe(true)
    expect(canRollbackRun(RunStatus.Completed, { rollbackAvailable: false })).toBe(false)
    expect(canRollbackRun(RunStatus.Completed, { rollbackAvailable: undefined })).toBe(false)
    expect(canRollbackRun(RunStatus.Completed, {
      rollbackAvailable: true,
      alreadyRolledBack: true,
    })).toBe(false)
  })
})

describe("canConfirmRollback", () => {
  it("requires work and no blockers", () => {
    expect(canConfirmRollback({ wouldCompensate: [], wouldFail: [] })).toBe(false)
    expect(canConfirmRollback({ wouldCompensate: [{}], wouldFail: [] })).toBe(true)
    expect(canConfirmRollback({ wouldCompensate: [{}], wouldFail: [{}] })).toBe(false)
  })
})

describe("isRunCapabilityActionAllowed", () => {
  it("gates resume-run and rollback-run; passes other actions", () => {
    expect(isRunCapabilityActionAllowed("view-run", RunStatus.Failed, {
      hasCheckpoint: false,
      rollbackAvailable: false,
    })).toBe(true)
    expect(isRunCapabilityActionAllowed("resume-run", RunStatus.Failed, {
      hasCheckpoint: true,
      rollbackAvailable: false,
    })).toBe(true)
    expect(isRunCapabilityActionAllowed("resume-run", RunStatus.Failed, {
      hasCheckpoint: false,
      rollbackAvailable: false,
    })).toBe(false)
    expect(isRunCapabilityActionAllowed("rollback-run", RunStatus.Completed, {
      hasCheckpoint: false,
      rollbackAvailable: true,
    })).toBe(true)
    expect(isRunCapabilityActionAllowed("rollback-run", RunStatus.Completed, {
      hasCheckpoint: false,
      rollbackAvailable: false,
    })).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { OperationStatus } from "../../client/index"
import { opLogShowEntityIcon, opLogShowStatusPill } from "./op-log-row-policy"

describe("op-log-row-policy", () => {
  it("always shows status pill on pipeline rows", () => {
    expect(opLogShowStatusPill({ pipelineRow: true, status: OperationStatus.Success })).toBe(true)
    expect(opLogShowStatusPill({ pipelineRow: true, status: OperationStatus.Failed })).toBe(true)
  })

  it("hides OK pills on stage and leaf rows (dots / quiet path)", () => {
    expect(opLogShowStatusPill({ status: OperationStatus.Success })).toBe(false)
    expect(opLogShowStatusPill({ status: OperationStatus.Success, leaf: true })).toBe(false)
  })

  it("keeps FAIL / Running pills on child rows (errors break flow)", () => {
    expect(opLogShowStatusPill({ status: OperationStatus.Failed })).toBe(true)
    expect(opLogShowStatusPill({ status: OperationStatus.Failed, leaf: true })).toBe(true)
    expect(opLogShowStatusPill({ status: OperationStatus.Running })).toBe(true)
  })

  it("shows entity icon only on pipeline list rows", () => {
    expect(opLogShowEntityIcon({ pipelineRow: true })).toBe(true)
    expect(opLogShowEntityIcon({})).toBe(false)
  })
})

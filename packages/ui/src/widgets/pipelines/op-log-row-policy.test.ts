import { describe, expect, it } from "vitest"
import { OperationStatus } from "../../client/index"
import { opLogShowEntityIcon, opLogShowStatusPill } from "./op-log-row-policy"

describe("op-log-row-policy", () => {
  it("always shows status pill on pipeline rows", () => {
    expect(opLogShowStatusPill({ pipelineRow: true, status: OperationStatus.Success })).toBe(true)
    expect(opLogShowStatusPill({ pipelineRow: true, status: OperationStatus.Failed })).toBe(true)
  })

  it("hides OK pills on child rows", () => {
    expect(opLogShowStatusPill({ status: OperationStatus.Success })).toBe(false)
  })

  it("shows pills for failed or in-flight child rows", () => {
    expect(opLogShowStatusPill({ status: OperationStatus.Failed })).toBe(true)
    expect(opLogShowStatusPill({ status: OperationStatus.Running })).toBe(true)
  })

  it("shows entity icon only on pipeline list rows", () => {
    expect(opLogShowEntityIcon({ pipelineRow: true })).toBe(true)
    expect(opLogShowEntityIcon({})).toBe(false)
  })
})

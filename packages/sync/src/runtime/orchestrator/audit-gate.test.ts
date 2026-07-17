import { describe, expect, it } from "vitest"

import { assertAuditGateAllowsProceed } from "./contract-deploy.js"
import { AuditGateSkippedError } from "./types.js"

describe("assertAuditGateAllowsProceed", () => {
  it("passes on success", () => {
    expect(() =>
      assertAuditGateAllowsProceed({ status: "success", message: "ok" }, "audit-check", "ctx")
    ).not.toThrow()
  })

  it("throws AuditGateSkippedError on stop (not a failure)", () => {
    expect(() =>
      assertAuditGateAllowsProceed(
        { status: "stop", message: "No changes — sync not required" },
        "audit-check",
        "ctx"
      )
    ).toThrow(AuditGateSkippedError)
    try {
      assertAuditGateAllowsProceed(
        { status: "stop", message: "No changes — sync not required" },
        "audit-check",
        "ctx"
      )
    } catch (e) {
      expect(e).toBeInstanceOf(AuditGateSkippedError)
      expect((e as AuditGateSkippedError).step).toBe("audit-check")
      expect((e as AuditGateSkippedError).message).toContain("No changes")
    }
  })

  it("throws when result row is missing", () => {
    expect(() => assertAuditGateAllowsProceed(null, "audit-check", "ctx")).toThrow(/no status row/)
  })
})

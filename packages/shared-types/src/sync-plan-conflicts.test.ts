import { describe, expect, it } from "vitest"
import {
  normalizeSyncPlanConflictKind,
  syncPlanConflictBannerLabel,
  syncPlanConflictExecuteHeadline
} from "./sync-plan-conflicts.js"

describe("sync-plan-conflicts labels", () => {
  it("normalizes unknown / missing kind to scope_misattribution", () => {
    expect(normalizeSyncPlanConflictKind(undefined)).toBe("scope_misattribution")
    expect(normalizeSyncPlanConflictKind("nope")).toBe("scope_misattribution")
    expect(normalizeSyncPlanConflictKind("missing_parent")).toBe("missing_parent")
  })

  it("picks a single-kind banner and execute headline from the catalog", () => {
    expect(
      syncPlanConflictBannerLabel([{ kind: "inbound_reference" }, { kind: "inbound_reference" }])
    ).toBe("inbound references — blocks execute")
    expect(syncPlanConflictExecuteHeadline([{ kind: "missing_parent" }])).toBe(
      "Missing parent blockers"
    )
  })

  it("uses mixed labels when kinds differ", () => {
    expect(
      syncPlanConflictBannerLabel([
        { kind: "inbound_reference" },
        { kind: "missing_parent" }
      ])
    ).toBe("conflicts — blocks execute")
    expect(
      syncPlanConflictExecuteHeadline([
        { kind: "inbound_reference" },
        { kind: "scope_misattribution" }
      ])
    ).toBe("Plan conflicts")
  })
})

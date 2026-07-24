import { describe, expect, it } from "vitest"
import { isQuietPlanNote, partitionPlanNotices } from "./plan-notices"

describe("plan-notices", () => {
  it("treats FK-only and scd2-schema lines as quiet notes", () => {
    expect(isQuietPlanNote("FK-only tables excluded by default: core.Step")).toBe(true)
    expect(isQuietPlanNote("[scd2-schema] core.Dataset: strategy columns omitted")).toBe(true)
    expect(isQuietPlanNote("[drift] column missing on target")).toBe(false)
    expect(isQuietPlanNote("Preview incomplete: 1/12 table(s) failed")).toBe(false)
  })

  it("partitions mixed plan notices", () => {
    const { notes, alerts } = partitionPlanNotices([
      "FK-only tables excluded by default: core.Step",
      "[drift] core.Foo missing",
      "[scd2-schema] omitted validFrom on core.Bar",
    ])
    expect(notes).toEqual([
      "FK-only tables excluded by default: core.Step",
      "[scd2-schema] omitted validFrom on core.Bar",
    ])
    expect(alerts).toEqual(["[drift] core.Foo missing"])
  })
})

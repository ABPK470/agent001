import { describe, expect, it } from "vitest"
import { withSyncExecutePolicyArgs } from "./sync-execute-policy-args.js"

describe("withSyncExecutePolicyArgs", () => {
  it("attaches plan source/target/entity when args omit them", () => {
    expect(
      withSyncExecutePolicyArgs(
        { planId: "p1", confirm: true },
        { source: "uat", target: "dev", entity: { type: "contract", id: 42, displayName: "Acme" } },
      ),
    ).toEqual({
      planId: "p1",
      confirm: true,
      source: "uat",
      target: "dev",
      entityType: "contract",
      entityId: 42,
    })
  })

  it("leaves args unchanged when plan is missing", () => {
    const args = { planId: "p1", confirm: true }
    expect(withSyncExecutePolicyArgs(args, null)).toBe(args)
  })

  it("does not overwrite an explicit target", () => {
    expect(
      withSyncExecutePolicyArgs(
        { planId: "p1", confirm: true, target: "prod" },
        { source: "uat", target: "dev", entity: { type: "contract", id: 1, displayName: null } },
      ).target,
    ).toBe("prod")
  })
})

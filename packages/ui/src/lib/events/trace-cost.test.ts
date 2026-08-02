import { describe, expect, it } from "vitest"
import {
  computeTokenCostUsd,
  formatCostUsd,
  pricingForModel,
} from "./trace-cost"

describe("trace-cost", () => {
  it("computes gpt-4o token cost", () => {
    const usd = computeTokenCostUsd("gpt-4o", 1000, 500)
    expect(usd).toBeCloseTo(0.0025 + 0.005, 6)
  })

  it("falls back for unknown models", () => {
    expect(pricingForModel("unknown-model-x")).toEqual(pricingForModel(null))
  })

  it("formats small USD amounts", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.0042")
    expect(formatCostUsd(0)).toBe("$0")
  })
})

import { describe, expect, it } from "vitest"
import { countContentTokenHits } from "./degraded-search.js"

describe("countContentTokenHits", () => {
  it("counts case-insensitive substring hits without claiming BM25", () => {
    expect(countContentTokenHits("Monthly KPI Report", ["monthly", "kpi"])).toBe(2)
    expect(countContentTokenHits("unrelated", ["monthly"])).toBe(0)
  })
})

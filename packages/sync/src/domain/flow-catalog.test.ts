import { describe, expect, it } from "vitest"

import { requirePublishedFlowCatalog } from "./flow-catalog.js"

describe("requirePublishedFlowCatalog", () => {
  it("returns catalog when present", () => {
    const catalog = { phases: {}, kinds: {}, customValueSources: {} }
    const def = {
      id: "contract",
      executionFlow: { steps: [], catalog },
    }
    expect(requirePublishedFlowCatalog(def)).toEqual({
      ...catalog,
      customValueSources: {},
    })
  })

  it("throws when catalog is missing", () => {
    const def = {
      id: "contract",
      executionFlow: { steps: [] },
    }
    expect(() => requirePublishedFlowCatalog(def)).toThrow(/Republish entity definitions/)
  })
})

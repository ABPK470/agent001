import { describe, expect, it } from "vitest"

import type { PublishedSyncDefinition } from "@mia/shared-types"

import { requirePublishedFlowCatalog } from "./flow-catalog.js"

describe("requirePublishedFlowCatalog", () => {
  it("returns catalog when present", () => {
    const catalog = { phases: {}, kinds: {}, customValueSources: {} }
    const def = {
      id: "contract",
      executionFlow: { steps: [], catalog },
    } as PublishedSyncDefinition
    expect(requirePublishedFlowCatalog(def)).toEqual({
      ...catalog,
      customValueSources: {},
    })
  })

  it("throws when catalog is missing", () => {
    const def = {
      id: "contract",
      executionFlow: { steps: [] },
    } as PublishedSyncDefinition
    expect(() => requirePublishedFlowCatalog(def)).toThrow(/Republish entity definitions/)
  })
})

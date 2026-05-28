import { describe, expect, it } from "vitest"

import { loadSyncRecipes } from "./recipes.js"

describe("loadSyncRecipes", () => {
  it("preserves explicit post-metadata actions from the compatibility bundle without inventing fallback flow", () => {
    const host = {
      sync: {
        recipes: { bundle: null, loadedFromPath: null },
      },
    } as never
    const bundle = loadSyncRecipes(host, process.cwd())
    const explicit = Object.values(bundle.recipes).find((recipe) => recipe?.postMetadataActions.length)
    expect(explicit?.postMetadataActions.length).toBeGreaterThan(0)
  })
})
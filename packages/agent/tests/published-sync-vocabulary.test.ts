import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  getPublishedSyncEntityIds,
  loadPublishedSyncEntityIdsFromBundle,
  resetPublishedSyncEntityIds
} from "../src/domain/tenant/published-sync-vocabulary.js"

afterEach(() => resetPublishedSyncEntityIds())

describe("published sync vocabulary", () => {
  it("loads entity ids from the repo bundle", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..")
    const ids = loadPublishedSyncEntityIdsFromBundle(
      "sync-definitions/published/definitions.bundle.json",
      { baseDir: repoRoot }
    )
    expect(ids).toContain("pipelineActivity")
    expect(ids).toContain("gateMetadata")
    expect(getPublishedSyncEntityIds()).toEqual(ids)
  })

  it("returns empty when bundle is missing", () => {
    expect(loadPublishedSyncEntityIdsFromBundle("/no/such/bundle.json")).toEqual([])
  })
})

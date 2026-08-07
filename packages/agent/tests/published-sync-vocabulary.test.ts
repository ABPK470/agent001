import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  getPublishedSyncEntityIds,
  loadPublishedSyncEntityIdsFromBundle,
  resetPublishedSyncEntityIds
} from "../src/domain/tenant/published-sync-vocabulary.js"

const tempRoots: string[] = []

afterEach(() => {
  resetPublishedSyncEntityIds()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("published sync vocabulary", () => {
  it("loads entity ids from a file bundle fixture", () => {
    // Production authority is SQLite; this exercises the legacy file loader only.
    const root = mkdtempSync(join(tmpdir(), "pub-sync-vocab-"))
    tempRoots.push(root)
    const dir = join(root, "sync-definitions", "published")
    mkdirSync(dir, { recursive: true })
    const bundlePath = join(dir, "definitions.bundle.json")
    writeFileSync(
      bundlePath,
      JSON.stringify({
        version: 1,
        publishedAt: "2026-01-01T00:00:00.000Z",
        publishedVersion: "test",
        definitions: {
          pipelineActivity: { id: "pipelineActivity" },
          gateMetadata: { id: "gateMetadata" }
        }
      })
    )

    const ids = loadPublishedSyncEntityIdsFromBundle(bundlePath)
    expect(ids).toContain("pipelineActivity")
    expect(ids).toContain("gateMetadata")
    expect(getPublishedSyncEntityIds()).toEqual(ids)
  })

  it("returns empty when bundle is missing", () => {
    expect(loadPublishedSyncEntityIdsFromBundle("/no/such/bundle.json")).toEqual([])
  })
})

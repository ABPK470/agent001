import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  formatPublishedSyncBundleMissingWarning,
  importLegacyPublishedBundleFileIfNeeded,
  loadPublishedSyncVocabularyAtBoot,
  reloadPublishedSyncVocabulary
} from "../src/boot/published-sync-bundle.js"
import { resetPublishedSyncEntityIds } from "@mia/agent"
import { _resetGoalClassificationCache } from "../src/runtime/prompting/goal-classification.js"

describe("published sync vocabulary boot", () => {
  let tempRoot: string
  let testDb: Database.Database
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "mia-bundle-boot-"))
    testDb = new Database(":memory:")
    testDb.pragma("foreign_keys = ON")
    const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
    _setDb(testDb)
    _migrate(testDb)
    resetPublishedSyncEntityIds()
    _resetGoalClassificationCache()
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
    testDb.close()
    rmSync(tempRoot, { recursive: true, force: true })
    resetPublishedSyncEntityIds()
    _resetGoalClassificationCache()
  })

  it("warns when SQLite has no published definitions", () => {
    const ids = loadPublishedSyncVocabularyAtBoot(tempRoot)
    expect(ids).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(formatPublishedSyncBundleMissingWarning())
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("loads vocabulary from SQLite sync_definitions rows", async () => {
    const { replaceSyncDefinitions } = await import("../src/infra/persistence/db/index.js")
    replaceSyncDefinitions("_default", {
      publishedAt: "2026-01-01T00:00:00.000Z",
      publishedVersion: "v1",
      catalogVersion: null,
      definitions: {
        pipelineActivity: { id: "pipelineActivity" },
        contract: { id: "contract" },
      },
    })

    const ids = loadPublishedSyncVocabularyAtBoot(tempRoot)
    expect(ids).toEqual(["contract", "pipelineActivity"])
    expect(logSpy).toHaveBeenCalledWith(
      "Published sync vocabulary: 2 entity types (contract, pipelineActivity)"
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("imports a legacy file bundle into SQLite when publish meta is empty", async () => {
    const dir = join(tempRoot, "sync-definitions", "published")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "definitions.bundle.json"),
      JSON.stringify({
        version: 1,
        publishedAt: "2026-01-02T00:00:00.000Z",
        publishedVersion: "legacy-v1",
        definitions: { rule: { id: "rule" }, contract: { id: "contract" } },
      })
    )

    expect(importLegacyPublishedBundleFileIfNeeded(tempRoot)).toBe(true)

    const { listSyncDefinitions, getSyncPublishMeta } =
      await import("../src/infra/persistence/db/index.js")
    expect(getSyncPublishMeta()?.published_version).toBe("legacy-v1")
    expect(listSyncDefinitions().map((row) => row.entity_id)).toEqual(["contract", "rule"])

    const ids = loadPublishedSyncVocabularyAtBoot(tempRoot)
    expect(ids).toEqual(["contract", "rule"])
    expect(importLegacyPublishedBundleFileIfNeeded(tempRoot)).toBe(false)
  })

  it("reloadPublishedSyncVocabulary updates in-process ids from SQLite", async () => {
    const { replaceSyncDefinitions } = await import("../src/infra/persistence/db/index.js")
    replaceSyncDefinitions("_default", {
      publishedAt: "2026-01-03T00:00:00.000Z",
      publishedVersion: "v2",
      catalogVersion: null,
      definitions: { rule: { id: "rule" } },
    })

    const ids = reloadPublishedSyncVocabulary(tempRoot)
    expect(ids).toEqual(["rule"])
  })
})

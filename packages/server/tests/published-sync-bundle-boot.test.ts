import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  formatPublishedSyncBundleMissingWarning,
  loadPublishedSyncVocabularyAtBoot,
  reloadPublishedSyncVocabulary
} from "../src/bootstrap/published-sync-bundle.js"
import { resetPublishedSyncEntityIds } from "@mia/agent"
import { _resetGoalClassificationCache } from "../src/features/runs/core/goal-classification.js"

describe("published sync bundle boot", () => {
  let tempRoot: string
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mia-bundle-boot-"))
    resetPublishedSyncEntityIds()
    _resetGoalClassificationCache()
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
    rmSync(tempRoot, { recursive: true, force: true })
    resetPublishedSyncEntityIds()
    _resetGoalClassificationCache()
  })

  it("warns when bundle is missing", () => {
    const ids = loadPublishedSyncVocabularyAtBoot(tempRoot)
    expect(ids).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(formatPublishedSyncBundleMissingWarning())
    expect(logSpy).not.toHaveBeenCalled()
  })

  it("loads vocabulary when bundle exists", () => {
    const dir = join(tempRoot, "sync-definitions", "published")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "definitions.bundle.json"),
      JSON.stringify({ definitions: { pipelineActivity: {}, contract: {} } })
    )

    const ids = loadPublishedSyncVocabularyAtBoot(tempRoot)
    expect(ids).toEqual(["contract", "pipelineActivity"])
    expect(logSpy).toHaveBeenCalledWith(
      "Published sync vocabulary: 2 entity types (contract, pipelineActivity)"
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("reloadPublishedSyncVocabulary updates in-process ids", () => {
    const dir = join(tempRoot, "sync-definitions", "published")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "definitions.bundle.json"),
      JSON.stringify({ definitions: { rule: {} } })
    )

    const ids = reloadPublishedSyncVocabulary(tempRoot)
    expect(ids).toEqual(["rule"])
  })
})

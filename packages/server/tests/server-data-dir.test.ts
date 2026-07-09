import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  resolveDbPath,
  resolveEvidenceDir,
  resolveServerDataDir,
  resolveSyncPlansDir,
} from "../src/platform/persistence/server-data-dir.js"

describe("server data dir", () => {
  const originalDataDir = process.env.MIA_DATA_DIR

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MIA_DATA_DIR
    else process.env.MIA_DATA_DIR = originalDataDir
  })

  it("defaults to ~/.mia with standard subpaths", () => {
    delete process.env.MIA_DATA_DIR
    const root = join(homedir(), ".mia")
    expect(resolveServerDataDir()).toBe(root)
    expect(resolveDbPath()).toBe(join(root, "mia.db"))
    expect(resolveSyncPlansDir()).toBe(join(root, "sync-plans"))
    expect(resolveEvidenceDir()).toBe(join(root, "evidence"))
  })

  it("honours MIA_DATA_DIR for all subpaths", () => {
    process.env.MIA_DATA_DIR = "/data/mia"
    expect(resolveDbPath()).toBe("/data/mia/mia.db")
    expect(resolveSyncPlansDir()).toBe("/data/mia/sync-plans")
    expect(resolveEvidenceDir()).toBe("/data/mia/evidence")
  })
})

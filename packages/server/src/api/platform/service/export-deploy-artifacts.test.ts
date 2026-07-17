import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { exportTimestampFolderName } from "./export-deploy-artifacts.js"

describe("export-deploy-artifacts", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("names export folders with a stable timestamp prefix", () => {
    const name = exportTimestampFolderName(new Date("2026-07-10T14:18:30.123Z"))
    expect(name).toMatch(/^mia-sync-export-2026-07-10T14-18-30-123Z$/)
  })

  it("uses a user parent directory, not deploy/sync seed paths", () => {
    const parent = mkdtempSync(join(tmpdir(), "mia-export-test-"))
    tempDirs.push(parent)
    const folderName = exportTimestampFolderName()
    const folderPath = join(parent, folderName)
    expect(folderPath.startsWith(parent)).toBe(true)
    expect(folderPath).not.toContain("deploy/sync/artifacts")
  })
})

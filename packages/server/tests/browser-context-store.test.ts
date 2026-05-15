/**
 * Tests for the persistent browser-context store.
 *
 * Verifies:
 *   - getOrCreateContext is idempotent per upn (one row, stable id)
 *   - storage state survives a save/load round-trip and lives in
 *     ~/.mia/browser-contexts (overridden via MIA_DATA_DIR)
 *   - fingerprint seed is captured from the upn and re-used
 *   - listContexts returns rows ordered by last_used_at desc
 */

import Database from "better-sqlite3"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedTestUsers } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-bctx-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("browser context store", () => {
  it("is idempotent per upn and round-trips storage state", async () => {
    const { _setDb, _migrate } = await import("../src/db/index.js")
    _migrate(testDb)
    seedTestUsers(testDb);
    _setDb(testDb)

    const { getOrCreateContext, loadStorageState, saveStorageState, listContexts } =
      await import("../src/browser/context-store.js")

    const a = getOrCreateContext("alice@example.com")
    const b = getOrCreateContext("alice@example.com")
    expect(a.id).toBe(b.id)
    expect(a.fingerprintSeed).toBe("alice@example.com")
    expect(a.storagePath.startsWith(join(dataDir, "browser-contexts"))).toBe(true)

    // No file yet → null
    expect(await loadStorageState(a)).toBeNull()

    const state = { cookies: [{ name: "sid", value: "xyz", domain: "example.com" }] }
    await saveStorageState(a, state)

    expect(existsSync(a.storagePath)).toBe(true)
    // Saved with restrictive perms (best-effort; skip on Windows).
    if (process.platform !== "win32") {
      const mode = statSync(a.storagePath).mode & 0o777
      expect(mode).toBe(0o600)
    }

    const reloaded = await loadStorageState(a)
    expect(reloaded).toEqual(state)

    const c = getOrCreateContext("bob@example.com")
    expect(c.id).not.toBe(a.id)
    expect(c.fingerprintSeed).toBe("bob@example.com")

    const all = listContexts()
    expect(all.length).toBe(2)
    // Most recently touched first
    expect(all[0]!.ownerUpn).toBe("bob@example.com")
  })
})

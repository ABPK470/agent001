/**
 * Attachment retention TTL + per-owner quota.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedTestUsers } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const ORIGINAL_QUOTA   = process.env["MIA_ATTACHMENT_OWNER_QUOTA_BYTES"]
const ORIGINAL_RUN_RET = process.env["MIA_ATTACHMENT_RETENTION_RUN_DAYS"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-attach-life-"))
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
  if (ORIGINAL_QUOTA === undefined) delete process.env["MIA_ATTACHMENT_OWNER_QUOTA_BYTES"]
  else process.env["MIA_ATTACHMENT_OWNER_QUOTA_BYTES"] = ORIGINAL_QUOTA
  if (ORIGINAL_RUN_RET === undefined) delete process.env["MIA_ATTACHMENT_RETENTION_RUN_DAYS"]
  else process.env["MIA_ATTACHMENT_RETENTION_RUN_DAYS"] = ORIGINAL_RUN_RET
})

describe("attachment lifecycle", () => {
  it("sets a retention_until on insert that respects the scope-specific TTL", async () => {
    process.env["MIA_ATTACHMENT_RETENTION_RUN_DAYS"] = "1"
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { uploadAttachment, getAttachment } = await import("../src/adapters/persistence/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb);
    const { seedRun } = await import("./_fk-helpers.js")
    seedRun(testDb, "r1")

    const before = Date.now()
    const a = await uploadAttachment({
      scope: "run", runId: "r1", ownerUpn: "u@x", originalName: "x.txt",
      mediaType: "text/plain", bytes: new TextEncoder().encode("hi"),
    })
    const row = getAttachment(a.id)
    expect(row?.retention_until).toBeTruthy()
    const ts = Date.parse(row!.retention_until!)
    // Should be ~1 day in the future.
    expect(ts - before).toBeGreaterThan(20 * 60 * 60 * 1000)
    expect(ts - before).toBeLessThan(28 * 60 * 60 * 1000)
  })

  it("pruneExpiredAttachments soft-deletes rows past their retention", async () => {
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { uploadAttachment, getAttachment, pruneExpiredAttachments }
      = await import("../src/adapters/persistence/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb);
    const { seedRun } = await import("./_fk-helpers.js")
    seedRun(testDb, "r1")

    const a = await uploadAttachment({
      scope: "run", runId: "r1", ownerUpn: "u@x", originalName: "x.txt",
      mediaType: "text/plain", bytes: new TextEncoder().encode("hi"),
    })
    // Manually fast-forward this row's retention into the past.
    testDb.prepare("UPDATE attachments SET retention_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(a.id)

    const result = pruneExpiredAttachments()
    expect(result.prunedAttachments).toBe(1)
    expect(getAttachment(a.id)).toBeUndefined()  // soft-deleted → hidden by getAttachment
  })

  it("rejects an upload that would exceed the per-owner quota", async () => {
    process.env["MIA_ATTACHMENT_OWNER_QUOTA_BYTES"] = "100"
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { uploadAttachment, QuotaExceededError, getOwnerUsage }
      = await import("../src/adapters/persistence/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb);

    await uploadAttachment({
      scope: "session", ownerUpn: "u@x", originalName: "a.bin",
      mediaType: "application/octet-stream", bytes: new Uint8Array(80),
    })
    const usage = getOwnerUsage("u@x")
    expect(usage.bytesUsed).toBe(80)
    expect(usage.bytesRemain).toBe(20)

    await expect(uploadAttachment({
      scope: "session", ownerUpn: "u@x", originalName: "b.bin",
      mediaType: "application/octet-stream", bytes: new Uint8Array(50),
    })).rejects.toBeInstanceOf(QuotaExceededError)
  })

  it("owner-less uploads are rejected (v19: every attachment has an owner)", async () => {
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { uploadAttachment } = await import("../src/adapters/persistence/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb);

    await expect(uploadAttachment({
      scope: "session", ownerUpn: null, originalName: "big.bin",
      mediaType: "application/octet-stream", bytes: new Uint8Array(1000),
    })).rejects.toThrow()
  })
})

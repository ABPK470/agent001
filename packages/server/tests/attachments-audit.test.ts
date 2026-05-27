/**
 * Attachment audit events fan out via the event broadcaster.
 *
 * We subscribe to the broadcaster, perform lifecycle operations, and
 * assert the expected attachment.* events fire with the right payload
 * shape. Bytes never appear in payloads.
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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-attach-audit-"))
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

describe("attachment audit events", () => {
  it("emits attachment.uploaded on upload and attachment.pruned on retention prune", async () => {
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { uploadAttachment, pruneExpiredAttachments } = await import("../src/adapters/persistence/attachments/index.js")
    const { subscribeToEvents } = await import("../src/event-broadcaster.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb);

    const events: { type: string; data: unknown }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data }))

    try {
      const a = await uploadAttachment({
        scope: "session", ownerUpn: "u@x", originalName: "x.txt",
        mediaType: "text/plain", bytes: new TextEncoder().encode("hi"),
      })

      const uploaded = events.find((e) => e.type === "attachment.uploaded")
      expect(uploaded).toBeTruthy()
      const data = uploaded!.data as Record<string, unknown>
      expect(data["id"]).toBe(a.id)
      expect(data["ownerUpn"]).toBe("u@x")
      expect(data["sizeBytes"]).toBe(2)
      expect(data["source"]).toBe("user_upload")
      // Bytes must never leak into audit payloads.
      expect(JSON.stringify(data)).not.toContain("hi")

      // Force expiry, then prune.
      testDb.prepare("UPDATE attachments SET retention_until = '2000-01-01T00:00:00Z' WHERE id = ?").run(a.id)
      pruneExpiredAttachments()

      const pruned = events.find((e) => e.type === "attachment.pruned")
      expect(pruned).toBeTruthy()
      expect((pruned!.data as { count: number }).count).toBe(1)
    } finally {
      unsub()
    }
  })
})

/**
 * Tests for the attachment metadata repo, content-addressed blob storage,
 * and the high-level upload service.
 *
 * Storage is redirected to a per-test temp directory via `MIA_DATA_DIR`,
 * which both the SQLite connection and the attachment store honour.
 */

import Database from "better-sqlite3"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedTestUsers } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string

// Stash original env so we can restore it cleanly.
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-attach-"))
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

describe("attachments DB layer", () => {
  it("normalizes filenames and dedupes identical content", async () => {
    // Re-import inside the test so each test sees the freshly-overridden
    // MIA_DATA_DIR. The attachment storage module reads the env at module
    // load time; vitest gives every test a fresh module graph here because
    // each beforeEach mutates env *before* the dynamic import.
    const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
    const { uploadAttachment, normalizeName, listAttachments, getAttachment, resolveStorageUri } =
      await import("../src/infra/persistence/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb)

    expect(normalizeName("../../etc/passwd")).toBe("passwd")
    expect(normalizeName("My Report (final).PDF")).toBe("My_Report_final.pdf")
    expect(normalizeName("...")).toBe("attachment")

    const bytesA = new TextEncoder().encode("hello world")
    const a1 = await uploadAttachment({
      scope: "user_draft",
      ownerUpn: "u@x",
      originalName: "a.txt",
      mediaType: "text/plain",
      bytes: bytesA
    })
    const a2 = await uploadAttachment({
      scope: "user_draft",
      ownerUpn: "u@x",
      originalName: "b.txt",
      mediaType: "text/plain",
      bytes: bytesA
    })

    // Same content → same hash and storage URI; different metadata rows.
    expect(a1.content_hash).toBe(a2.content_hash)
    expect(a1.storage_uri).toBe(a2.storage_uri)
    expect(a1.id).not.toBe(a2.id)
    expect(a1.ingestion_mode).toBe("text_retrieval")
    expect(a1.size_bytes).toBe(bytesA.byteLength)

    // Bytes are reachable on disk under the attachment root.
    const onDisk = readFileSync(resolveStorageUri(a1.storage_uri))
    expect(onDisk.toString()).toBe("hello world")

    // Distinct content gets a new blob.
    const bytesB = new TextEncoder().encode("different")
    const b = await uploadAttachment({
      scope: "user_draft",
      ownerUpn: "u@x",
      originalName: "c.bin",
      mediaType: "application/octet-stream",
      bytes: bytesB
    })
    expect(b.content_hash).not.toBe(a1.content_hash)
    expect(b.ingestion_mode).toBe("binary_reference")

    // Listing returns newest first.
    const list = listAttachments({ scope: "user_draft" })
    expect(list.map((r) => r.id)).toEqual([b.id, a2.id, a1.id])

    // Get returns the same row.
    expect(getAttachment(a1.id)?.original_name).toBe("a.txt")
  })

  it("filters by run, soft-deletes, and records imports", async () => {
    const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
    const {
      uploadAttachment,
      listAttachments,
      softDeleteAttachment,
      recordAttachmentImport,
      listAttachmentImports
    } = await import("../src/infra/persistence/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb)
    const { seedRuns } = await import("./_fk-helpers.js")
    seedRuns(testDb, ["run-1", "run-2"])

    const bytes = new TextEncoder().encode("payload")
    const r1 = await uploadAttachment({
      scope: "run",
      runId: "run-1",
      ownerUpn: "u@x",
      originalName: "x.txt",
      mediaType: "text/plain",
      bytes
    })
    const r2 = await uploadAttachment({
      scope: "run",
      runId: "run-2",
      ownerUpn: "u@x",
      originalName: "y.txt",
      mediaType: "text/plain",
      bytes
    })

    expect(listAttachments({ runId: "run-1" }).map((r) => r.id)).toEqual([r1.id])
    expect(listAttachments({ runId: "run-2" }).map((r) => r.id)).toEqual([r2.id])

    softDeleteAttachment(r1.id)
    expect(listAttachments({ runId: "run-1" })).toHaveLength(0)

    const imp = recordAttachmentImport({
      attachmentId: r2.id,
      runId: "run-2",
      sandboxPath: "sandbox://run-2/y.txt",
      importMode: "copy",
      importedByToolCall: "tool-42"
    })
    expect(imp.attachment_id).toBe(r2.id)
    expect(listAttachmentImports("run-2").map((i) => i.id)).toEqual([imp.id])
    expect(listAttachmentImports("run-1")).toHaveLength(0)
  })
})

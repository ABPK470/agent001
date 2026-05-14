/**
 * Tests for the server-side AttachmentService implementation.
 *
 * Exercises:
 *   - sandbox path validation (rejects ../ , absolute, NUL, drive escape)
 *   - text/binary classification on read()
 *   - importToSandbox copies bytes and records the import row
 *   - list() defaults to the active run (resolved via HostedPolicyContext)
 */

import { runWithPolicyContext, type HostedPolicyContext } from "@mia/agent"
import Database from "better-sqlite3"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
let sandboxRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-attach-svc-"))
  sandboxRoot = mkdtempSync(join(tmpdir(), "mia-sandbox-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(sandboxRoot, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

function makeCtx(over: Partial<HostedPolicyContext> = {}): HostedPolicyContext {
  return {
    runId:       over.runId       ?? "run-1",
    runMode:     over.runMode     ?? "hosted",
    role:        over.role        ?? "hosted_user",
    sandboxRoot: over.sandboxRoot ?? sandboxRoot,
    actorUpn:    over.actorUpn    ?? null,
    sessionId:   over.sessionId   ?? null,
  }
}

describe("server attachment service", () => {
  it("rejects path-traversal and absolute destinations", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { uploadAttachment, serverAttachmentService } = await import("../src/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    const { seedRun } = await import("./_fk-helpers.js")
    seedRun(testDb, "run-1")

    const a = await uploadAttachment({
      scope: "run", runId: "run-1", originalName: "x.txt", mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    })

    await runWithPolicyContext(makeCtx(), async () => {
      await expect(serverAttachmentService.importToSandbox(a.id, "../escape.txt")).rejects.toThrow(/escapes/)
      await expect(serverAttachmentService.importToSandbox(a.id, "/abs/path.txt")).rejects.toThrow(/sandbox-relative/)
      await expect(serverAttachmentService.importToSandbox(a.id, "")).rejects.toThrow(/empty/)
      await expect(serverAttachmentService.importToSandbox(a.id, "with\0null.txt")).rejects.toThrow(/illegal/)
    })
  })

  it("imports a file into the sandbox and records the import", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { uploadAttachment, serverAttachmentService, listAttachmentImports }
      = await import("../src/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    const { seedRun } = await import("./_fk-helpers.js")
    seedRun(testDb, "run-1")

    const a = await uploadAttachment({
      scope: "run", runId: "run-1", originalName: "data.csv", mediaType: "text/csv",
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
    })

    const result = await runWithPolicyContext(makeCtx(), () =>
      serverAttachmentService.importToSandbox(a.id, "inputs/data.csv"),
    )
    expect(result.sandboxPath).toBe(join(sandboxRoot, "inputs/data.csv"))
    expect(result.sizeBytes).toBe(8)
    expect(readFileSync(result.sandboxPath, "utf8")).toBe("a,b\n1,2\n")
    const imports = listAttachmentImports("run-1")
    expect(imports).toHaveLength(1)
    expect(imports[0]?.attachment_id).toBe(a.id)
    expect(imports[0]?.import_mode).toBe("copy")
  })

  it("read() returns text for text-media and binary for the rest, honouring maxBytes", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { uploadAttachment, serverAttachmentService } = await import("../src/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    const { seedRun } = await import("./_fk-helpers.js")
    seedRun(testDb, "run-1")

    const text = await uploadAttachment({
      scope: "run", runId: "run-1", originalName: "n.txt", mediaType: "text/plain",
      bytes: new TextEncoder().encode("abcdefghij"),
    })
    const bin = await uploadAttachment({
      scope: "run", runId: "run-1", originalName: "n.bin", mediaType: "application/octet-stream",
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
    })

    await runWithPolicyContext(makeCtx(), async () => {
      const t = await serverAttachmentService.read(text.id, { maxBytes: 4 })
      expect(t.kind).toBe("text")
      expect(t.text).toBe("abcd")
      expect(t.truncated).toBe(true)
      expect(t.sizeBytes).toBe(10)

      const b = await serverAttachmentService.read(bin.id)
      expect(b.kind).toBe("binary")
      expect(b.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
      expect(b.truncated).toBe(false)
    })
  })

  it("list() defaults to the active run when no filter is supplied", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { uploadAttachment, serverAttachmentService } = await import("../src/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)
    const { seedRuns } = await import("./_fk-helpers.js")
    seedRuns(testDb, ["run-1", "run-other"])

    await uploadAttachment({ scope: "run", runId: "run-1", originalName: "a.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("x") })
    await uploadAttachment({ scope: "run", runId: "run-other", originalName: "b.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("y") })

    const rows = await runWithPolicyContext(makeCtx({ runId: "run-1" }), () =>
      serverAttachmentService.list(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.originalName).toBe("a.txt")
  })

  it("throws a clear error when called outside a run context", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { serverAttachmentService } = await import("../src/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)

    await expect(serverAttachmentService.list()).rejects.toThrow(/active run context/)
  })

  it("promoteFromSandbox stores generated files with source=generated bound to the run", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { serverAttachmentService, getAttachment } = await import("../src/attachments/index.js")
    const { writeFileSync, mkdirSync } = await import("node:fs")
    _setDb(testDb)
    _migrate(testDb)
    const { seedRun, seedSession } = await import("./_fk-helpers.js")
    seedSession(testDb, "sid-x")
    seedRun(testDb, "run-promote", { sessionSid: "sid-x" })

    // Simulate the agent producing a report inside the sandbox.
    mkdirSync(join(sandboxRoot, "out"), { recursive: true })
    writeFileSync(join(sandboxRoot, "out/report.csv"), "a,b\n1,2\n")

    const meta = await runWithPolicyContext(
      makeCtx({ runId: "run-promote", actorUpn: "owner@example.com", sessionId: "sid-x" }),
      () => serverAttachmentService.promoteFromSandbox("out/report.csv"),
    )

    expect(meta.normalizedName).toBe("report.csv")
    expect(meta.mediaType).toBe("text/csv")
    expect(meta.sizeBytes).toBe(8)

    const row = getAttachment(meta.id)
    expect(row).toBeTruthy()
    expect(row?.source).toBe("generated")
    expect(row?.scope).toBe("workspace_asset")
    expect(row?.run_id).toBe("run-promote")
    expect(row?.owner_upn).toBe("owner@example.com")
    expect(row?.session_id).toBe("sid-x")
  })

  it("promoteFromSandbox refuses paths that escape the sandbox", async () => {
    const { _setDb, _migrate } = await import("../src/db.js")
    const { serverAttachmentService } = await import("../src/attachments/index.js")
    _setDb(testDb)
    _migrate(testDb)

    await runWithPolicyContext(makeCtx(), async () => {
      await expect(serverAttachmentService.promoteFromSandbox("../escape.txt")).rejects.toThrow(/escapes/)
      await expect(serverAttachmentService.promoteFromSandbox("/abs/path.txt")).rejects.toThrow(/sandbox-relative/)
    })
  })
})

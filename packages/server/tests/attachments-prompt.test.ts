/**
 * Unit-level tests for the per-run attachment manifest that
 * buildSystemMessages renders into Section 3b of the system prompt.
 *
 * We exercise buildSystemMessages directly with a developer-profile
 * RunWorkspaceContext so the workspace tree section is short and the
 * attachment block is easy to find. Storage and DB are isolated to
 * per-test temp directories.
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
  dataDir = mkdtempSync(join(tmpdir(), "mia-attach-prompt-"))
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

describe("attachments in system prompt", () => {
  it("includes a manifest line per attachment when ids are supplied", async () => {
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { uploadAttachment } = await import("../src/adapters/persistence/attachments/index.js")
    const { buildSystemMessages } = await import("../src/application/core/system-messages.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb)
    const { seedRun } = await import("./_fk-helpers.js")
    seedRun(testDb, "r1")

    const a = await uploadAttachment({
      scope: "run",
      runId: "r1",
      ownerUpn: "u@x",
      originalName: "spec.csv",
      mediaType: "text/csv",
      bytes: new TextEncoder().encode("a,b\n1,2\n")
    })
    const b = await uploadAttachment({
      scope: "run",
      runId: "r1",
      ownerUpn: "u@x",
      originalName: "image.png",
      mediaType: "image/png",
      bytes: new Uint8Array([0, 1, 2, 3])
    })

    const messages = await buildSystemMessages({
      goal: "summarise the inputs",
      systemPrompt: "BASE PROMPT",
      allTools: [],
      runWorkspace: {
        profile: "developer",
        executionRoot: null,
        sourceRoot: null,
        isolated: false
      } as never,
      perTier: { working: "", episodic: "", semantic: "" },
      runId: "r1",
      attachmentIds: [a.id, b.id, "missing-id-should-be-ignored"]
    })
    const blob = messages.map((m) => m.content).join("\n\n")

    expect(blob).toContain("Attached files for this run")
    expect(blob).toContain(`id=${a.id}`)
    expect(blob).toContain("name=spec.csv")
    expect(blob).toContain("type=text/csv")
    expect(blob).toContain(`id=${b.id}`)
    expect(blob).toContain("type=image/png")
    expect(blob).toContain("mode=binary_reference")
    expect(blob).toContain("mode=text_retrieval")
    // Unknown ids are silently dropped, not echoed back into the prompt.
    expect(blob).not.toContain("missing-id-should-be-ignored")
  })

  it("omits the manifest section entirely when no attachments are bound", async () => {
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { buildSystemMessages } = await import("../src/application/core/system-messages.js")
    _setDb(testDb)
    _migrate(testDb)
    seedTestUsers(testDb)

    const messages = await buildSystemMessages({
      goal: "x",
      systemPrompt: "BASE",
      allTools: [],
      runWorkspace: {
        profile: "developer",
        executionRoot: null,
        sourceRoot: null,
        isolated: false
      } as never,
      perTier: { working: "", episodic: "", semantic: "" },
      runId: "r1",
      attachmentIds: []
    })
    const blob = messages.map((m) => m.content).join("\n\n")
    expect(blob).not.toContain("Attached files for this run")
  })
})

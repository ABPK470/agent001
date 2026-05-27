/**
 * Hosted-mode end-to-end happy path.
 *
 * Walks the full hosted lifecycle from the user's perspective without
 * spinning up Fastify or the LLM:
 *
 *   1. user uploads an attachment through the service (route shape)
 *   2. agent enters its run inside an empty sandbox (hosted profile)
 *   3. agent calls list_attachments → read_attachment → import_attachment
 *   4. agent produces a derived file in the sandbox
 *   5. agent calls promote_attachment to make it durable
 *   6. assert the promoted row is bound to the run with source=generated
 *      and that the audit event log captured every step in order
 */

import { configureAgent, createImportAttachmentTool, createListAttachmentsTool, createPromoteAttachmentTool, createReadAttachmentTool, type HostedPolicyContext } from "@mia/agent"
import Database from "better-sqlite3"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
let sandboxRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const ORIGINAL_HOSTED   = process.env["AGENT_HOSTED_MODE"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-e2e-data-"))
  sandboxRoot = mkdtempSync(join(tmpdir(), "mia-e2e-sandbox-"))
  process.env["MIA_DATA_DIR"] = dataDir
  process.env["AGENT_HOSTED_MODE"] = "true"
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
  if (ORIGINAL_HOSTED === undefined) delete process.env["AGENT_HOSTED_MODE"]
  else process.env["AGENT_HOSTED_MODE"] = ORIGINAL_HOSTED
})

function ctx(over: Partial<HostedPolicyContext> = {}): HostedPolicyContext {
  return {
    runId:       over.runId       ?? "run-e2e",
    runMode:     "hosted",
    role:        "hosted_user",
    sandboxRoot: over.sandboxRoot ?? sandboxRoot,
    actorUpn:    over.actorUpn    ?? "alice@example.com",
    sessionId:   over.sessionId   ?? "sid-alice",
  }
}

describe("hosted-mode end-to-end happy path", () => {
  it("upload → list → read → import → produce → promote, with audit", async () => {
    const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
    const { createServerAttachmentService, uploadAttachment, getAttachment, listAttachments }
      = await import("../src/adapters/persistence/attachments/index.js")
    const { subscribeToEvents } = await import("../src/event-broadcaster.js")
    _setDb(testDb)
    _migrate(testDb)

    const attachmentService = createServerAttachmentService(() => ctx())
    const host = configureAgent({ attachments: attachmentService })
    const listAttachmentsTool   = createListAttachmentsTool(host)
    const readAttachmentTool    = createReadAttachmentTool(host)
    const importAttachmentTool  = createImportAttachmentTool(host)
    const promoteAttachmentTool = createPromoteAttachmentTool(host)
    // Seed FK parents required by the attachments table.
    const { seedSession, seedRun } = await import("./_fk-helpers.js")
    seedSession(testDb, "sid-alice", "alice@example.com")
    seedRun(testDb, "run-e2e", { sessionSid: "sid-alice" })

    // 1. user upload (mimics POST /api/attachments)
    const uploaded = await uploadAttachment({
      scope:        "session",
      ownerUpn:     "alice@example.com",
      sessionId:    "sid-alice",
      originalName: "input.csv",
      mediaType:    "text/csv",
      bytes:        new TextEncoder().encode("a,b\n1,2\n3,4\n"),
    })
    expect(uploaded.source).toBe("user_upload")

    const events: { type: string; data: Record<string, unknown> }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }))

    try {
      // 2-5. agent runs inside its hosted policy context.
      // The agent typically supplies its run id when listing across scopes;
      // here we list without filter so it sees its own run + session uploads.
      const list = await listAttachmentsTool.execute({})
      expect(String(list)).toContain(uploaded.id)

      const read = await readAttachmentTool.execute({ id: uploaded.id })
      expect(String(read)).toContain("a,b")

      const importRes = await importAttachmentTool.execute({
        id: uploaded.id, destination: "inputs/data.csv",
      })
      expect(String(importRes)).toContain("Imported")
      expect(readFileSync(join(sandboxRoot, "inputs/data.csv"), "utf8")).toContain("a,b")

      // Agent produces a derived report inside the sandbox.
      writeFileSync(join(sandboxRoot, "report.md"), "# summary\n2 rows\n")

      const promoteRes = await promoteAttachmentTool.execute({
        sandboxPath: "report.md",
        purposeTag:  "final-report",
      })
      expect(String(promoteRes)).toContain("Promoted")
    } finally {
      unsub()
    }

    // 6. promoted row is durable and bound to the run / user.
    const all = listAttachments({})
    const generated = all.find((r) => r.source === "generated")
    expect(generated).toBeTruthy()
    expect(generated?.run_id).toBe("run-e2e")
    expect(generated?.owner_upn).toBe("alice@example.com")
    expect(generated?.normalized_name).toBe("report.md")
    expect(generated?.scope).toBe("workspace_asset")
    expect(getAttachment(generated!.id)?.purpose_tag).toBe("final-report")

    // Audit fired the right events in order.
    const types = events.map((e) => e.type)
    expect(types).toContain("attachment.imported")
    expect(types).toContain("attachment.promoted")
    expect(types).toContain("attachment.uploaded")  // promotion is itself an upload
    expect(types.indexOf("attachment.imported")).toBeLessThan(types.indexOf("attachment.promoted"))
  })
})

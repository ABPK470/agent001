/**
 * Tests for ingestAgentNote — the write-side helper for the agent's `note`
 * tool. Verifies happy-path persistence, salience floor override, dedup,
 * tenant isolation, and provenance stamping.
 *
 * Uses the same in-memory SQLite + _setDb pattern as memory-tenancy.test.ts.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-note-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setupMemory() {
  const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  const { migrateMemory } = await import("../src/adapters/persistence/memory/index.js")
  migrateMemory()
  return await import("../src/adapters/persistence/memory/index.js")
}

describe("ingestAgentNote", () => {
  it("persists a note to working memory with summary role and agent source", async () => {
    const mem = await setupMemory()

    const res = mem.ingestAgentNote({
      subject: "publish.Revenue.RevenueZARMTD",
      claim: "cumulative MTD column; non-summable across periods",
      category: "column_semantics",
      sessionId: "s1",
      runId: "r1",
      upn: "alice@corp"
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return

    const row = testDb
      .prepare(
        `SELECT tier, role, source, confidence, content, upn, session_id, metadata
       FROM memory_entries WHERE id = ?`
      )
      .get(res.id) as {
      tier: string
      role: string
      source: string
      confidence: number
      content: string
      upn: string
      session_id: string
      metadata: string
    }

    expect(row.tier).toBe("working")
    expect(row.role).toBe("summary")
    expect(row.source).toBe("agent")
    expect(row.confidence).toBe(0.75) // no evidence → baseline
    expect(row.upn).toBe("alice@corp")
    expect(row.session_id).toBe("s1")
    expect(row.content).toContain("[note:column_semantics]")
    expect(row.content).toContain("publish.Revenue.RevenueZARMTD")
    expect(row.content).toContain("non-summable")

    const meta = JSON.parse(row.metadata) as Record<string, unknown>
    expect(meta["type"]).toBe("agent_note")
    expect(meta["category"]).toBe("column_semantics")
    expect(meta["subject"]).toBe("publish.Revenue.RevenueZARMTD")
  })

  it("raises confidence to 0.85 when evidence is provided", async () => {
    const mem = await setupMemory()

    const res = mem.ingestAgentNote({
      subject: "publish.Revenue",
      claim: "row count 1.2M as of 2026-01",
      evidence: "profile_data result: distinct values per client = 12 per year",
      sessionId: "s1",
      upn: "alice@corp"
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    const row = testDb.prepare(`SELECT confidence, content FROM memory_entries WHERE id = ?`).get(res.id) as {
      confidence: number
      content: string
    }
    expect(row.confidence).toBe(0.85)
    expect(row.content).toContain("ev: profile_data result")
  })

  it("accepts terse notes that would fail the default salience floor", async () => {
    const mem = await setupMemory()
    // A very short note whose value is the subject identifier, not prose.
    const res = mem.ingestAgentNote({
      subject: "join:A↔B",
      claim: "FK on pkClient",
      sessionId: "s1",
      upn: "alice@corp"
    })
    expect(res.ok).toBe(true)
  })

  it("dedups a second identical note in the same session", async () => {
    const mem = await setupMemory()
    const a = mem.ingestAgentNote({
      subject: "publish.Balance.BalanceZAR",
      claim: "snapshot balance column; sum across clients meaningful, sum across time is not",
      sessionId: "s1",
      upn: "alice@corp"
    })
    expect(a.ok).toBe(true)
    const b = mem.ingestAgentNote({
      subject: "publish.Balance.BalanceZAR",
      claim: "snapshot balance column; sum across clients meaningful, sum across time is not",
      sessionId: "s1",
      upn: "alice@corp"
    })
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.reason).toBe("duplicate")

    const count = testDb
      .prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE upn = 'alice@corp' AND session_id = 's1'`)
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  it("isolates notes by tenant — Bob does not see Alice's note", async () => {
    const mem = await setupMemory()
    const a = mem.ingestAgentNote({
      subject: "publish.Revenue",
      claim: "alice-only-fact-keyword-XYZABC123",
      sessionId: "s1",
      upn: "alice@corp"
    })
    expect(a.ok).toBe(true)

    // Same subject + claim from a different UPN should NOT collide with Alice's
    // entry because dedup is tenant-scoped.
    const b = mem.ingestAgentNote({
      subject: "publish.Revenue",
      claim: "alice-only-fact-keyword-XYZABC123",
      sessionId: "s1",
      upn: "bob@corp"
    })
    expect(b.ok).toBe(true)

    const rows = testDb
      .prepare(
        `SELECT upn FROM memory_entries WHERE content LIKE '%alice-only-fact-keyword-XYZABC123%' ORDER BY upn`
      )
      .all() as Array<{ upn: string }>
    expect(rows.map((r) => r.upn)).toEqual(["alice@corp", "bob@corp"])
  })

  it("rejects empty subject or claim with invalid_input", async () => {
    const mem = await setupMemory()
    const a = mem.ingestAgentNote({ subject: "  ", claim: "ok", sessionId: "s1", upn: "u" })
    expect(a.ok).toBe(false)
    if (a.ok) return
    expect(a.reason).toBe("invalid_input")

    const b = mem.ingestAgentNote({ subject: "ok", claim: "", sessionId: "s1", upn: "u" })
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.reason).toBe("invalid_input")
  })

  it("defaults category to 'observation' when omitted", async () => {
    const mem = await setupMemory()
    const res = mem.ingestAgentNote({
      subject: "publish.Foo",
      claim: "miscellaneous note about a table that does not fit a category",
      sessionId: "s1",
      upn: "alice@corp"
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const row = testDb.prepare(`SELECT content, metadata FROM memory_entries WHERE id = ?`).get(res.id) as {
      content: string
      metadata: string
    }
    expect(row.content).toContain("[note:observation]")
    expect(JSON.parse(row.metadata)["category"]).toBe("observation")
  })
})

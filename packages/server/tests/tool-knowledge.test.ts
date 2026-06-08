/**
 * Tests for the tool_knowledge org-wide cache helper.
 *
 * Uses the same in-memory SQLite + `_setDb` pattern as
 * memory-ingest-note.test.ts. The cache is org-wide (no upn filter on reads);
 * this test fixture verifies that and the freshness/fingerprint semantics.
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
  dataDir = mkdtempSync(join(tmpdir(), "mia-tk-"))
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
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  const { migrateMemory } = await import("../src/platform/persistence/memory/index.js")
  migrateMemory()
  return await import("../src/platform/persistence/memory/index.js")
}

const FP_A = { cols: 5, type: "T" as const, csum: "deadbeef" }
const FP_B = { cols: 5, type: "T" as const, csum: "cafebabe" }

describe("tool_knowledge — save + lookup", () => {
  it("returns miss when nothing has been written", async () => {
    const mem = await setupMemory()
    const r = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Balances",
      mode: "fast",
      currentFingerprint: FP_A
    })
    expect(r.hit).toBe(false)
    if (!r.hit) expect(r.reason).toBe("miss")
  })

  it("saves a payload and a subsequent lookup returns hit with same payload", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Balances",
      mode: "fast",
      payload: "rowCount=51000000\ncolumns: ...",
      fingerprint: FP_A,
      upn: "alice@corp",
      now: 1_000_000_000_000
    })
    const r = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Balances",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 1_000_000_000_000 + 60_000
    })
    expect(r.hit).toBe(true)
    if (!r.hit) return
    expect(r.payload).toContain("rowCount=51000000")
    expect(r.createdByUpn).toBe("alice@corp")
    expect(r.ageMs).toBe(60_000)
  })

  it("upserts on the same (tool, qname, mode, connection) — does not insert a duplicate", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.X",
      mode: "fast",
      payload: "v1",
      fingerprint: FP_A,
      now: 1_000
    })
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.X",
      mode: "fast",
      payload: "v2",
      fingerprint: FP_A,
      now: 2_000
    })
    const rows = testDb
      .prepare(`SELECT COUNT(*) AS n FROM tool_knowledge WHERE tool='profile_data' AND qname='publish.X'`)
      .get() as { n: number }
    expect(rows.n).toBe(1)

    const r = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.X",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 2_500
    })
    expect(r.hit).toBe(true)
    if (r.hit) expect(r.payload).toBe("v2")
  })

  it("treats different modes as separate cache entries", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Y",
      mode: "fast",
      payload: "FAST",
      fingerprint: FP_A,
      now: 1_000
    })
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Y",
      mode: "deep",
      payload: "DEEP",
      fingerprint: FP_A,
      now: 1_000
    })
    const a = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Y",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 2_000
    })
    const b = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Y",
      mode: "deep",
      currentFingerprint: FP_A,
      now: 2_000
    })
    expect(a.hit && a.payload).toBe("FAST")
    expect(b.hit && b.payload).toBe("DEEP")
  })

  it("returns stale when age exceeds TTL", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Z",
      mode: "fast",
      payload: "old",
      fingerprint: FP_A,
      now: 0
    })
    // FAST TTL is 30 days; advance 31.
    const r = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Z",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 31 * 24 * 60 * 60 * 1000
    })
    expect(r.hit).toBe(false)
    if (!r.hit) expect(r.reason).toBe("stale")
  })

  it("returns fingerprint mismatch when the current catalog fingerprint differs", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Q",
      mode: "fast",
      payload: "x",
      fingerprint: FP_A,
      now: 1_000
    })
    const r = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Q",
      mode: "fast",
      currentFingerprint: FP_B,
      now: 2_000
    })
    expect(r.hit).toBe(false)
    if (!r.hit) expect(r.reason).toBe("fingerprint")
  })

  it("bumps hit_count and last_hit_at on each successful lookup", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.H",
      mode: "fast",
      payload: "x",
      fingerprint: FP_A,
      now: 1_000
    })
    mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.H",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 2_000
    })
    mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.H",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 3_000
    })
    const row = testDb
      .prepare(`SELECT hit_count, last_hit_at FROM tool_knowledge WHERE qname='publish.H'`)
      .get() as { hit_count: number; last_hit_at: number }
    expect(row.hit_count).toBe(2)
    expect(row.last_hit_at).toBe(3_000)
  })

  it("is cross-UPN by default — a different user gets the same cached payload", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Cross",
      mode: "fast",
      payload: "shared-data",
      fingerprint: FP_A,
      upn: "alice@corp",
      now: 1_000
    })
    // Lookup does not take a `upn` arg at all — Bob just calls and reads.
    const r = mem.lookupToolKnowledge({
      tool: "profile_data",
      qname: "publish.Cross",
      mode: "fast",
      currentFingerprint: FP_A,
      now: 2_000
    })
    expect(r.hit).toBe(true)
    if (r.hit) {
      expect(r.payload).toBe("shared-data")
      expect(r.createdByUpn).toBe("alice@corp")
    }
  })
})

describe("tool_knowledge — fingerprint helper", () => {
  it("returns null when the catalog has no entry for the object", async () => {
    const mem = await setupMemory()
    expect(mem.fingerprintFromCatalogTable(null)).toBeNull()
    expect(mem.fingerprintFromCatalogTable(undefined)).toBeNull()
  })

  it("produces equal fingerprints for the same column shape, regardless of column order? -- order matters", async () => {
    const mem = await setupMemory()
    const a = mem.fingerprintFromCatalogTable({
      type: "TABLE",
      columns: [
        { name: "id", dataType: "int" },
        { name: "name", dataType: "varchar" }
      ]
    })!
    const b = mem.fingerprintFromCatalogTable({
      type: "TABLE",
      columns: [
        { name: "id", dataType: "int" },
        { name: "name", dataType: "varchar" }
      ]
    })!
    expect(mem.fingerprintsEqual(a, b)).toBe(true)
  })

  it("produces different fingerprints when a column type changes", async () => {
    const mem = await setupMemory()
    const a = mem.fingerprintFromCatalogTable({
      type: "TABLE",
      columns: [{ name: "id", dataType: "int" }]
    })!
    const b = mem.fingerprintFromCatalogTable({
      type: "TABLE",
      columns: [{ name: "id", dataType: "bigint" }]
    })!
    expect(mem.fingerprintsEqual(a, b)).toBe(false)
  })

  it("produces different fingerprints when type flips between TABLE and VIEW", async () => {
    const mem = await setupMemory()
    const a = mem.fingerprintFromCatalogTable({
      type: "TABLE",
      columns: [{ name: "id", dataType: "int" }]
    })!
    const b = mem.fingerprintFromCatalogTable({
      type: "VIEW",
      columns: [{ name: "id", dataType: "int" }]
    })!
    expect(mem.fingerprintsEqual(a, b)).toBe(false)
  })
})

describe("tool_knowledge — TTL config", () => {
  it("returns the right TTL per tool/mode and falls back to default", async () => {
    const mem = await setupMemory()
    const DAY = 24 * 60 * 60 * 1000
    expect(mem.ttlForToolMode("profile_data", "fast")).toBe(30 * DAY)
    expect(mem.ttlForToolMode("profile_data", "deep")).toBe(14 * DAY)
    expect(mem.ttlForToolMode("profile_data", "unknown")).toBe(30 * DAY)
    expect(mem.ttlForToolMode("inspect_definition", "definition")).toBe(30 * DAY)
    expect(mem.ttlForToolMode("discover_relationships", "fk")).toBe(60 * DAY)
  })
})

describe("tool_knowledge — prune", () => {
  it("removes rows older than maxAgeMs", async () => {
    const mem = await setupMemory()
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.Old",
      mode: "fast",
      payload: "x",
      fingerprint: FP_A,
      now: 1_000
    })
    mem.saveToolKnowledge({
      tool: "profile_data",
      qname: "publish.New",
      mode: "fast",
      payload: "y",
      fingerprint: FP_A,
      now: 100_000
    })
    const removed = mem.pruneToolKnowledge({ maxAgeMs: 50_000, now: 100_000 })
    expect(removed).toBe(1)
    const rows = testDb.prepare(`SELECT qname FROM tool_knowledge ORDER BY qname`).all() as Array<{
      qname: string
    }>
    expect(rows.map((r) => r.qname)).toEqual(["publish.New"])
  })
})

describe("tool_knowledge — renderCachedHeader", () => {
  it("renders a stable [cached from DATE, mode=X, ageHours=Y, source=tool_knowledge] header", async () => {
    const mem = await setupMemory()
    const profiledAt = Date.UTC(2026, 4, 1) // 2026-05-01
    const now = profiledAt + 3 * 60 * 60 * 1000 // +3h
    const header = mem.renderCachedHeader(
      {
        hit: true,
        payload: "irrelevant",
        ageMs: now - profiledAt,
        profiledAt,
        fingerprint: FP_A,
        createdByUpn: null
      },
      { tool: "profile_data", mode: "fast" }
    )
    expect(header).toBe("[cached from 2026-05-01, mode=fast, ageHours=3, source=tool_knowledge]")
  })
})

/**
 * `<known_objects>` system-anchor block — extraction + rendering tests.
 *
 * We bypass the full systemMessages builder and exercise the pure
 * functions directly (`loadKnownObjects`, `renderKnownObjectsBlock`)
 * against an in-memory SQLite. The integration is one line — caller
 * passes the result through to `buildSystemMessages({ knownObjects })`
 * which simply renders+injects when non-empty.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadKnownObjects, renderKnownObjectsBlock } from "../src/orchestrator/known-objects.js"
import type { PriorTurn } from "../src/orchestrator/prior-turns.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-ko-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
  const { _setDb, _migrate } = await import("../src/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  const { migrateMemory } = await import("../src/memory/index.js")
  migrateMemory()
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

function seed(rows: Array<{ qname: string; tool: string; mode: string; bytes: number; ageMs: number }>): void {
  const stmt = testDb.prepare(`
    INSERT INTO tool_knowledge (tool, qname, mode, connection, payload_text, fingerprint, bytes, created_at, hit_count)
    VALUES (?, ?, ?, 'default', '...', '5|T|deadbeef', ?, ?, 0)
  `)
  const now = Date.now()
  for (const r of rows) {
    stmt.run(r.tool, r.qname, r.mode, r.bytes, now - r.ageMs)
  }
}

const emptyTurns: readonly PriorTurn[] = []

describe("loadKnownObjects — qname extraction", () => {
  it("falls back to the global tail when goal has no schema.table candidates (Gap 3)", () => {
    // When the goal mentions no qnames (very common for follow-ups like
    // "top 50 clients"), Gap 3 surfaces the freshest cached entries so
    // the LLM still sees previously-touched objects.
    seed([{ qname: "publish.balances", tool: "profile_data", mode: "fast", bytes: 100, ageMs: 1000 }])
    const out = loadKnownObjects({ db: testDb, goal: "what's the weather today?", priorTurns: emptyTurns })
    expect(out).toHaveLength(1)
    expect(out[0]!.qname).toBe("publish.balances")
  })

  it("returns [] when no candidates AND cache is completely empty", () => {
    const out = loadKnownObjects({
      db: testDb,
      goal: "profile publish.Balances please",
      priorTurns: emptyTurns,
    })
    expect(out).toEqual([])
  })

  it("returns a hit for a qname mentioned in the goal", () => {
    seed([{ qname: "publish.balances", tool: "profile_data", mode: "fast", bytes: 1234, ageMs: 3_600_000 }])
    const out = loadKnownObjects({
      db: testDb,
      goal: "Plot publish.Balances by month",
      priorTurns: emptyTurns,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.qname).toBe("publish.balances")
    expect(out[0]!.tool).toBe("profile_data")
    expect(out[0]!.ageHours).toBe(1)
  })

  it("extracts qnames from prior-turn goal AND answer text", () => {
    seed([
      { qname: "dim.date", tool: "profile_data", mode: "fast", bytes: 100, ageMs: 1000 },
      { qname: "publish.balances", tool: "inspect_definition", mode: "definition", bytes: 200, ageMs: 1000 },
    ])
    const priorTurns: PriorTurn[] = [
      { id: "r1", goal: "show me dim.Date counts", answer: "I queried publish.Balances and got 12 rows", status: "completed", ranAt: "2025-01-01" },
    ]
    const out = loadKnownObjects({ db: testDb, goal: "follow up", priorTurns })
    const qnames = out.map((r) => r.qname).sort()
    expect(qnames).toEqual(["dim.date", "publish.balances"])
  })

  it("dedupes by qname keeping the newest entry", () => {
    seed([
      { qname: "publish.balances", tool: "profile_data", mode: "fast", bytes: 100, ageMs: 24 * 3_600_000 },
      { qname: "publish.balances", tool: "profile_data", mode: "deep", bytes: 200, ageMs: 1 * 3_600_000 },
    ])
    const out = loadKnownObjects({
      db: testDb,
      goal: "Re-profile publish.Balances",
      priorTurns: emptyTurns,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.mode).toBe("deep")
    expect(out[0]!.ageHours).toBe(1)
  })
})

describe("renderKnownObjectsBlock", () => {
  it("returns '' for an empty list (caller skips injection)", () => {
    expect(renderKnownObjectsBlock([])).toBe("")
  })

  it("renders a compact qname | tool | mode | age | bytes table", () => {
    const block = renderKnownObjectsBlock([
      { qname: "publish.balances", tool: "profile_data", mode: "fast", ageHours: 2, bytes: 1500 },
      { qname: "dim.date", tool: "inspect_definition", mode: "definition", ageHours: 24, bytes: 800 },
    ])
    expect(block).toContain("<known_objects>")
    expect(block).toContain("</known_objects>")
    expect(block).toContain("publish.balances | profile_data | fast | 2h | 1500B")
    expect(block).toContain("dim.date | inspect_definition | definition | 24h | 800B")
  })

  it("caps the block at the size limit (no single qname can blow the budget)", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      qname: `huge.Table${i.toString().padStart(4, "0")}`,
      tool: "profile_data",
      mode: "fast",
      ageHours: i,
      bytes: 1000,
    }))
    const block = renderKnownObjectsBlock(rows)
    expect(block.length).toBeLessThan(3000)
    expect(block).toContain("</known_objects>")
  })
})

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
import {
  loadKnownObjects,
  renderKnownObjectsBlock
} from "../src/api/runs/prompting/data-blocks/known-objects.js"
import type { PriorTurn } from "../src/api/runs/prompting/data-blocks/prior-turns.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-ko-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

function seed(
  rows: Array<{ qname: string; tool: string; mode: string; bytes: number; ageMs: number; payload?: string }>
): void {
  const stmt = testDb.prepare(`
    INSERT INTO tool_knowledge (tool, qname, mode, connection, payload_text, fingerprint, bytes, created_at, hit_count)
    VALUES (?, ?, ?, 'default', ?, '5|T|deadbeef', ?, ?, 0)
  `)
  const now = Date.now()
  for (const r of rows) {
    stmt.run(r.tool, r.qname, r.mode, r.payload ?? "...", r.bytes, now - r.ageMs)
  }
}

const emptyTurns: readonly PriorTurn[] = []

describe("loadKnownObjects — qname extraction", () => {
  it("falls back to the global tail when goal has no schema.table candidates (Gap 3)", () => {
    // When the goal mentions no qnames (very common for follow-ups like
    // "top 50 clients"), Gap 3 surfaces the freshest cached entries so
    // the LLM still sees previously-touched objects.
    seed([{ qname: "publish.balances", tool: "profile_data", mode: "fast", bytes: 100, ageMs: 1000 }])
    const out = loadKnownObjects({
      db: testDb,
      goal: "what's the weather today?",
      priorTurns: emptyTurns
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.qname).toBe("publish.balances")
  })

  it("returns [] when no candidates AND cache is completely empty", () => {
    const out = loadKnownObjects({
      db: testDb,
      goal: "profile publish.Balances please",
      priorTurns: emptyTurns
    })
    expect(out).toEqual([])
  })

  it("returns a hit for a qname mentioned in the goal", () => {
    seed([{ qname: "publish.balances", tool: "profile_data", mode: "fast", bytes: 1234, ageMs: 3_600_000 }])
    const out = loadKnownObjects({
      db: testDb,
      goal: "Plot publish.Balances by month",
      priorTurns: emptyTurns
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.qname).toBe("publish.balances")
    expect(out[0]!.tool).toBe("profile_data")
    expect(out[0]!.ageHours).toBe(1)
  })

  it("extracts qnames from prior-turn goal AND answer text", () => {
    seed([
      { qname: "dim.date", tool: "profile_data", mode: "fast", bytes: 100, ageMs: 1000 },
      {
        qname: "publish.balances",
        tool: "inspect_definition",
        mode: "definition",
        bytes: 200,
        ageMs: 1000
      }
    ])
    const priorTurns: PriorTurn[] = [
      {
        id: "r1",
        goal: "show me dim.Date counts",
        answer: "I queried publish.Balances and got 12 rows",
        status: "completed",
        ranAt: "2025-01-01"
      }
    ]
    const out = loadKnownObjects({ db: testDb, goal: "follow up", priorTurns })
    const qnames = out.map((r) => r.qname).sort()
    expect(qnames).toEqual(["dim.date", "publish.balances"])
  })

  it("dedupes by qname keeping the newest entry", () => {
    seed([
      {
        qname: "publish.balances",
        tool: "profile_data",
        mode: "fast",
        bytes: 100,
        ageMs: 24 * 3_600_000
      },
      {
        qname: "publish.balances",
        tool: "profile_data",
        mode: "deep",
        bytes: 200,
        ageMs: 1 * 3_600_000
      }
    ])
    const out = loadKnownObjects({
      db: testDb,
      goal: "Re-profile publish.Balances",
      priorTurns: emptyTurns
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.mode).toBe("deep")
    expect(out[0]!.ageHours).toBe(1)
  })

  it("populates summary + priority='goal' when the qname comes from the goal text", () => {
    const profilePayload = [
      "Profile (FAST mode) for publish.balances:",
      "  Type: TABLE",
      "  Total rows: 1,000",
      "",
      "Columns (3):",
      "  Id (int, NOT NULL)",
      "  Amount (decimal, nullable)",
      "  Date (datetime, NOT NULL)"
    ].join("\n")
    seed([
      {
        qname: "publish.balances",
        tool: "profile_data",
        mode: "fast",
        bytes: 500,
        ageMs: 3_600_000,
        payload: profilePayload
      }
    ])
    const out = loadKnownObjects({ db: testDb, goal: "show me publish.Balances", priorTurns: emptyTurns })
    expect(out).toHaveLength(1)
    expect(out[0]!.priority).toBe("goal")
    expect(out[0]!.summary).toContain("rows=1,000")
    expect(out[0]!.summary).toContain("Id(int)")
  })

  it("leaves summary='' and priority='fallback' for rows surfaced only via Gap-3 top-up", () => {
    // Goal mentions nothing schema.table-shaped — fallback path kicks in.
    seed([
      {
        qname: "publish.balances",
        tool: "profile_data",
        mode: "fast",
        bytes: 500,
        ageMs: 1000,
        payload: "Profile (FAST mode) for publish.balances:\n  Type: TABLE"
      }
    ])
    const out = loadKnownObjects({ db: testDb, goal: "what is happening today", priorTurns: emptyTurns })
    expect(out).toHaveLength(1)
    expect(out[0]!.priority).toBe("fallback")
    expect(out[0]!.summary).toBe("")
  })
})

describe("renderKnownObjectsBlock", () => {
  it("returns '' for an empty list (caller skips injection)", () => {
    expect(renderKnownObjectsBlock([])).toBe("")
  })

  it("renders fallback rows as a compact qname | tool | mode | age | bytes table", () => {
    const block = renderKnownObjectsBlock([
      {
        qname: "publish.balances",
        tool: "profile_data",
        mode: "fast",
        ageHours: 2,
        bytes: 1500,
        priority: "fallback",
        summary: ""
      },
      {
        qname: "dim.date",
        tool: "inspect_definition",
        mode: "definition",
        ageHours: 24,
        bytes: 800,
        priority: "fallback",
        summary: ""
      }
    ])
    expect(block).toContain("<known_objects>")
    expect(block).toContain("</known_objects>")
    expect(block).toContain("publish.balances | profile_data | fast | 2h | 1500B")
    expect(block).toContain("dim.date | inspect_definition | definition | 24h | 800B")
    expect(block).toContain("Directory (cache exists, summary not inlined)")
  })

  it("renders goal rows with an inline header + summary (multi-line)", () => {
    const block = renderKnownObjectsBlock([
      {
        qname: "publish.balances",
        tool: "profile_data",
        mode: "fast",
        ageHours: 3,
        bytes: 1500,
        priority: "goal",
        summary:
          "fast: rows=1,000, type=table, indexes=2; cols(4): Id(int), Date(datetime), Amount(decimal), Status(varchar)"
      }
    ])
    expect(block).toContain("publish.balances [profile_data/fast, 3h ago, 1500B]")
    expect(block).toContain("fast: rows=1,000")
    expect(block).toContain("Id(int)")
    expect(block).toContain("treat that summary as AUTHORITATIVE")
    // Goal rows must NOT appear in the fallback directory table.
    expect(block).not.toContain("publish.balances | profile_data | fast")
  })

  it("caps the block at MAX_CHARS so a flood of fallback rows can't blow the budget", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      qname: `huge.Table${i.toString().padStart(4, "0")}`,
      tool: "profile_data",
      mode: "fast",
      ageHours: i,
      bytes: 1000,
      priority: "fallback" as const,
      summary: ""
    }))
    const block = renderKnownObjectsBlock(rows)
    expect(block.length).toBeLessThan(4100)
    expect(block).toContain("</known_objects>")
  })

  it("priority-aware eviction: when budget is tight, goal rows render and fallback / verdicts drop first", () => {
    // One real goal row plus a flood of fallback rows + a flood of verdicts.
    // The goal row's header AND summary must survive; trailing fallback /
    // verdict entries get evicted.
    const goalRow = {
      qname: "publish.revenue",
      tool: "profile_data",
      mode: "fast",
      ageHours: 1,
      bytes: 1200,
      priority: "goal" as const,
      summary:
        "fast: rows=1,234,567, type=table, indexes=3; cols(14): Id(int), CustomerId(int), Amount(decimal), Date(datetime)"
    }
    const fallbacks = Array.from({ length: 200 }, (_, i) => ({
      qname: `noise.T${i}`,
      tool: "profile_data",
      mode: "fast",
      ageHours: i,
      bytes: 100,
      priority: "fallback" as const,
      summary: ""
    }))
    const verdicts = Array.from({ length: 100 }, (_, i) => ({
      qname: `noise.V${i}`,
      role: "canonical" as const,
      evidence: ["seeded"]
    }))
    const block = renderKnownObjectsBlock([goalRow, ...fallbacks], verdicts)
    expect(block).toContain("publish.revenue [profile_data/fast, 1h ago, 1200B]")
    expect(block).toContain("fast: rows=1,234,567")
    expect(block).toContain("Id(int)")
    expect(block.length).toBeLessThan(4100)
  })
})

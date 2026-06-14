/**
 * Episodic goal-class recall — choreography folded into episodic summaries.
 *
 * A substantive run stored from "list top 3 products based on revenue for April 2025"
 * must be recallable by a surface-different goal sharing the shape
 * ("top 50 clients by revenue") via CamelCase class-tag overlap on the
 * same episodic FTS index.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RunStatus } from "@mia/agent"
import {
  extractOrderedToolSequence,
  formatChoreographyLine
} from "../src/platform/persistence/memory/episodic-choreography.js"
import { augmentGoalQueryForFts, extractGoalClasses } from "../src/platform/persistence/memory/goal-class.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

const TOOL_TRACE = [
  { kind: "tool-call", tool: "search_catalog", text: "search_catalog(...)", argsSummary: "term=revenue" },
  { kind: "tool-call", tool: "explore_mssql_schema", text: "explore(...)", argsSummary: "table=publish.Revenue" },
  { kind: "tool-call", tool: "profile_data", text: "profile(...)", argsSummary: "table=publish.Revenue" },
  { kind: "tool-call", tool: "query_mssql", text: "query(...)", argsSummary: "SELECT TOP …" }
] as const

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-epgc-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

function ingestSubstantiveRun(
  mem: typeof import("../src/platform/persistence/memory/index.js"),
  opts: { id: string; goal: string; upn: string }
): void {
  mem.ingestRunTurns({
    id: opts.id,
    goal: opts.goal,
    answer: "Top products by revenue are in publish.Revenue for April 2025.",
    status: RunStatus.Completed,
    agentId: null,
    tools: ["search_catalog", "explore_mssql_schema", "profile_data", "query_mssql"],
    stepCount: TOOL_TRACE.length,
    trace: [...TOOL_TRACE],
    upn: opts.upn
  })
}

describe("extractGoalClasses", () => {
  it("tags a ranking-by-metric time-filtered pivot-by-dim goal", () => {
    const classes = extractGoalClasses("list top 3 products based on revenue for April 2025")
    expect(classes).toContain("rankbymetric")
    expect(classes).toContain("timefiltered")
    expect(classes).toContain("lookup")
  })

  it("tags a ranking-by-metric goal whose dim is the ranked entity", () => {
    const classes = extractGoalClasses("top 50 clients by revenue")
    expect(classes).toContain("rankbymetric")
  })

  it("returns [] for goals with no shape signal", () => {
    expect(extractGoalClasses("hello there friend")).toEqual([])
  })
})

describe("episodic choreography extraction", () => {
  it("extracts ordered substantive tools and formats a choreography line", () => {
    const seq = extractOrderedToolSequence(TOOL_TRACE)
    expect(seq).toEqual([
      "search_catalog",
      "explore_mssql_schema",
      "profile_data",
      "query_mssql"
    ])
    expect(formatChoreographyLine(seq)).toBe(
      "Choreography: search_catalog → explore_mssql_schema → profile_data → query_mssql"
    )
  })

  it("skips low-signal tools like ask_user", () => {
    const seq = extractOrderedToolSequence([
      { kind: "tool-call", tool: "search_catalog" },
      { kind: "tool-call", tool: "ask_user" },
      { kind: "tool-call", tool: "query_mssql" }
    ])
    expect(seq).toEqual(["search_catalog", "query_mssql"])
  })
})

describe("episodic recall — goal-class overlap", () => {
  it("recalls a prior run across surface-different but shape-similar goals", async () => {
    const mem = await import("../src/platform/persistence/memory/index.js")
    ingestSubstantiveRun(mem, {
      id: "r1",
      goal: "list top 3 products based on revenue for April 2025",
      upn: "user@example.com"
    })

    const hits = await mem.searchEntries(augmentGoalQueryForFts("top 50 clients by revenue"), {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "user@example.com"
    })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.entry.metadata["toolSequence"]).toEqual([
      "search_catalog",
      "explore_mssql_schema",
      "profile_data",
      "query_mssql"
    ])
    expect(hits[0]!.entry.content).toContain("Choreography:")
    expect(hits[0]!.entry.content).toContain("[goalclasses")
  })

  it("still recalls on literal-token overlap", async () => {
    const mem = await import("../src/platform/persistence/memory/index.js")
    ingestSubstantiveRun(mem, {
      id: "r2",
      goal: "list top 3 products based on revenue for April 2025",
      upn: "user@example.com"
    })

    const hits = await mem.searchEntries(augmentGoalQueryForFts("list top 5 products based on revenue"), {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "user@example.com"
    })
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it("does NOT match wholly unrelated goals", async () => {
    const mem = await import("../src/platform/persistence/memory/index.js")
    ingestSubstantiveRun(mem, {
      id: "r3",
      goal: "list top 3 products based on revenue for April 2025",
      upn: "user@example.com"
    })

    const hits = await mem.searchEntries(augmentGoalQueryForFts("hello there friend"), {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "user@example.com"
    })
    expect(hits).toEqual([])
  })

  it("stores goal-class tail on the episodic goal line for FTS indexing", async () => {
    const mem = await import("../src/platform/persistence/memory/index.js")
    ingestSubstantiveRun(mem, {
      id: "r4",
      goal: "total revenue per month",
      upn: "user@example.com"
    })

    const row = testDb
      .prepare(`SELECT content FROM memory_entries WHERE tier = 'episodic' AND run_id = 'r4'`)
      .get() as { content: string }
    expect(row.content).toContain("[goalclasses")
    expect(row.content).toContain("aggregateby")
    expect(row.content).toContain("pivotbydim")
  })
})

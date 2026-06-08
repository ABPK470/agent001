/**
 * Gap 5 — goal-class procedural recall.
 *
 * A recipe stored from "list top 3 products based on revenue for April 2025"
 * must be recallable by a surface-different goal sharing the SHAPE
 * ("top 50 clients by revenue") via CamelCase class-tag overlap.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { extractGoalClasses } from "../src/adapters/persistence/memory/goal-class.js"
import { searchProcedures, storeProcedural } from "../src/adapters/persistence/memory/procedural.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-gc-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
  const { _setDb, _migrate } = await import("../src/adapters/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  // _migrate re-enables foreign_keys after the hard-reset; turn it off
  // again so this suite can use synthetic runIds without seeding the
  // runs table. Cascade behaviour is covered by dedicated FK tests.
  testDb.pragma("foreign_keys = OFF")
  const { migrateMemory } = await import("../src/adapters/persistence/memory/index.js")
  migrateMemory()
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("extractGoalClasses", () => {
  it("tags a ranking-by-metric time-filtered pivot-by-dim goal", () => {
    const classes = extractGoalClasses("list top 3 products based on revenue for April 2025")
    expect(classes).toContain("rankbymetric")
    expect(classes).toContain("timefiltered")
    expect(classes).toContain("lookup")
  })

  it("tags a ranking-by-metric goal whose dim is the ranked entity", () => {
    // "top 50 clients by revenue" — ranked entity is `clients`, metric
    // is `revenue`. The `by` here introduces the METRIC, not the
    // pivoting dim, so pivotbydim deliberately does not fire. Class
    // overlap with the stored "top 3 products based on revenue …"
    // recipe still happens via rankbymetric, which is sufficient.
    const classes = extractGoalClasses("top 50 clients by revenue")
    expect(classes).toContain("rankbymetric")
  })

  it("tags pivotbydim when the goal explicitly groups by a dim", () => {
    const classes = extractGoalClasses("total revenue per month")
    expect(classes).toContain("aggregateby")
    expect(classes).toContain("pivotbydim")
  })

  it("tags an aggregation comparison goal", () => {
    const classes = extractGoalClasses("compare total revenue yoy")
    expect(classes).toContain("aggregateby")
    expect(classes).toContain("comparison")
  })

  it("returns [] for empty / whitespace input", () => {
    expect(extractGoalClasses("")).toEqual([])
    expect(extractGoalClasses("   ")).toEqual([])
  })

  it("returns [] for goals with no shape signal", () => {
    expect(extractGoalClasses("hello there friend")).toEqual([])
  })
})

describe("procedural recall — Gap 5 class-tag overlap", () => {
  const toolSeq = [
    { tool: "search_catalog", argsPattern: { summary: "term=revenue" } },
    { tool: "explore_mssql_schema", argsPattern: { summary: "table=publish.Revenue" } },
    { tool: "profile_data", argsPattern: { summary: "table=publish.Revenue mode=fast" } },
    { tool: "query_mssql", argsPattern: { summary: "SELECT TOP …" } }
  ]

  it("recalls a recipe across surface-different but shape-similar goals", () => {
    storeProcedural({
      trigger: "list top 3 products based on revenue for April 2025",
      toolSequence: toolSeq,
      runId: "r1",
      upn: "user@example.com"
    })

    // Surface-different goal (no "top 3", no "products", no "April 2025"),
    // but shares rankbymetric + pivotbydim class tags.
    const hits = searchProcedures("top 50 clients by revenue", 5, "user@example.com")
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.toolSequence.map((s) => s.tool)).toEqual([
      "search_catalog",
      "explore_mssql_schema",
      "profile_data",
      "query_mssql"
    ])
  })

  it("still recalls on literal-token overlap (no regression for similar wording)", () => {
    storeProcedural({
      trigger: "list top 3 products based on revenue for April 2025",
      toolSequence: toolSeq,
      runId: "r2",
      upn: "user@example.com"
    })

    const hits = searchProcedures("list top 5 products based on revenue", 5, "user@example.com")
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it("does NOT match wholly unrelated goals", () => {
    storeProcedural({
      trigger: "list top 3 products based on revenue for April 2025",
      toolSequence: toolSeq,
      runId: "r3",
      upn: "user@example.com"
    })

    const hits = searchProcedures("hello there friend", 5, "user@example.com")
    expect(hits).toEqual([])
  })

  it("appends the [goalclasses …] tail to the stored trigger so FTS indexes the tags", () => {
    const proc = storeProcedural({
      trigger: "total revenue per month",
      toolSequence: toolSeq,
      runId: "r4",
      upn: "user@example.com"
    })
    expect(proc.trigger).toContain("[goalclasses")
    expect(proc.trigger).toContain("aggregateby")
    expect(proc.trigger).toContain("pivotbydim")
  })
})

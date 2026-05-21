/**
 * Doctrine auto-note tests (Gap 2).
 *
 * Verifies:
 *   1. DOCTRINE_LESSON_TEMPLATES exists for every code that has a fixHint
 *      and is wired into a block branch (aggregate, temp-integrity, temp-scalar).
 *   2. validateQueryDetailed attaches a non-null `lesson` to the three
 *      block branches that have templates.
 *   3. mssqlTool.execute routes the lesson to currentRuntime().memory.writeNote
 *      when validation blocks.
 *
 * The writer hook is observed via a spy bound on a temporary AgentRuntime;
 * no DB / no server-side ingestion is exercised here (that's covered by
 * memory-ingest-note.test.ts in the server package).
 */

import { describe, expect, it, vi } from "vitest"
import { AgentRuntime } from "../src/agent-runtime.js"
import {
    DOCTRINE_FIX_HINTS,
    DOCTRINE_LESSON_TEMPLATES,
    getDoctrineLessonTemplate,
} from "../src/doctrine/fix-hints.js"
import { mssqlTool } from "../src/tools/mssql/tools.js"
import { validateQueryDetailed } from "../src/tools/mssql/validation.js"

describe("DOCTRINE_LESSON_TEMPLATES registry", () => {
  it("covers the doctrines that have wired block branches", () => {
    expect(Object.keys(DOCTRINE_LESSON_TEMPLATES).sort()).toEqual([
      "aggregate_semantic_mismatch",
      "avg_of_coalesce_zero",
      "publish_view_topn_without_branch_aggregation",
      "temp_scalar_subquery_overused",
      "temp_table_integrity",
    ])
  })

  it("every covered code also has a fix hint (the two surfaces agree)", () => {
    for (const code of Object.keys(DOCTRINE_LESSON_TEMPLATES)) {
      expect(DOCTRINE_FIX_HINTS[code], `${code} must have a fix hint`).toBeTruthy()
    }
  })

  it("getDoctrineLessonTemplate returns null for unknown codes", () => {
    expect(getDoctrineLessonTemplate("not_a_real_code")).toBeNull()
  })

  it("lesson templates produce payloads with stable subject prefixes", () => {
    const agg = DOCTRINE_LESSON_TEMPLATES.aggregate_semantic_mismatch!({
      query: "SELECT SUM(x) AS Avg_y FROM t",
      detail: "SUM(x) AS Avg_y",
    })
    expect(agg).not.toBeNull()
    expect(agg!.subject).toMatch(/^doctrine:aggregate-semantic-mismatch:/)
    expect(agg!.category).toBe("column_semantics")
    expect(agg!.claim).toContain("profile_data")

    const tmp = DOCTRINE_LESSON_TEMPLATES.temp_table_integrity!({
      query: "SELECT * FROM #x_a3f91c08",
      detail: "Query blocked: #x referenced without being created.",
    })
    expect(tmp).not.toBeNull()
    expect(tmp!.subject).toMatch(/^doctrine:temp-table-integrity:/)
    expect(tmp!.claim).toContain("ONE query_mssql call")

    const scal = DOCTRINE_LESSON_TEMPLATES.temp_scalar_subquery_overused!({
      query: "SELECT ... FROM #t",
      detail: "#s_a3f91c08 (2 scalar probes)",
    })
    expect(scal).not.toBeNull()
    expect(scal!.subject).toMatch(/^doctrine:temp-scalar-subquery:/)
    expect(scal!.category).toBe("performance")
    expect(scal!.claim).toContain("discover_relationships")
  })
})

describe("validateQueryDetailed attaches lesson on blocking diagnostics", () => {
  it("aggregate-semantic mismatch yields a lesson", () => {
    const out = validateQueryDetailed("SELECT SUM(x) AS Avg_y FROM t", false)
    expect(out.ok).toBe(false)
    expect(out.code).toBe("aggregate_semantic_mismatch")
    expect(out.lesson).not.toBeNull()
    expect(out.lesson!.subject).toMatch(/^doctrine:aggregate-semantic-mismatch:/)
  })

  it("temp-table integrity violation yields a lesson", () => {
    const out = validateQueryDetailed(
      "CREATE TABLE #created_a3f91c08 (x int);\nSELECT * FROM #missing_a3f91c08;",
      false,
    )
    expect(out.ok).toBe(false)
    expect(out.code).toBe("temp_table_integrity")
    expect(out.lesson).not.toBeNull()
    expect(out.lesson!.subject).toMatch(/^doctrine:temp-table-integrity:/)
  })

  it("repeated temp scalar subqueries yield a lesson", () => {
    const out = validateQueryDetailed(
      [
        "SELECT t.k,",
        "  (SELECT COUNT(*) FROM #s_a3f91c08 s WHERE s.k = t.k) AS c1,",
        "  (SELECT SUM(v)   FROM #s_a3f91c08 s WHERE s.k = t.k) AS c2",
        "FROM #t_a3f91c08 t",
      ].join("\n"),
      false,
    )
    expect(out.ok).toBe(false)
    expect(out.code).toBe("temp_scalar_subquery_overused")
    expect(out.lesson).not.toBeNull()
    expect(out.lesson!.subject).toContain("#s_a3f91c08")
  })

  it("non-blocking validation leaves lesson absent/null", () => {
    const out = validateQueryDetailed("SELECT 1", false)
    expect(out.ok).toBe(true)
    expect(out.lesson ?? null).toBeNull()
  })
})

describe("mssqlTool wires lesson into runtime.memory.writeNote on block", () => {
  // The mssql tool fetches the connection pool BEFORE validating, so without
  // a configured pool the validator never runs. Inject a no-network pool
  // stub keyed off the global runtime so the tool reaches validation.
  it("calls writeNote with the lesson payload when validation blocks", async () => {
    const writeNote = vi.fn()
    const runtime = new AgentRuntime({ workspaceRoot: process.cwd() })
    runtime.memory.writeNote = writeNote

    // Plant a fake database entry with a pre-connected pool stub so getPool
    // resolves without hitting a real server.
    runtime.mssql.databases.set("default", {
      config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
      pool: { request: () => ({ cancel: () => undefined, query: async () => ({ recordset: [] }) }), connected: true, close: async () => undefined } as never,
      writeEnabled: false,
      knowledge: null,
    })

    const result = await runtime.run(() => mssqlTool.execute({
      query: "SELECT SUM(x) AS Avg_y FROM t",
    }))

    expect(typeof result).toBe("string")
    expect(result).toMatch(/aggregate-semantic mismatch/i)

    expect(writeNote).toHaveBeenCalledTimes(1)
    const payload = writeNote.mock.calls[0]![0]
    expect(payload.subject).toMatch(/^doctrine:aggregate-semantic-mismatch:/)
    expect(payload.claim).toContain("profile_data")
    expect(payload.category).toBe("column_semantics")
  })

  it("swallows writeNote exceptions silently (block error still returned)", async () => {
    const runtime = new AgentRuntime({ workspaceRoot: process.cwd() })
    runtime.memory.writeNote = () => { throw new Error("boom") }
    runtime.mssql.databases.set("default", {
      config: { server: "stub", database: "stub", user: "u", password: "p" } as never,
      pool: { request: () => ({ cancel: () => undefined, query: async () => ({ recordset: [] }) }), connected: true, close: async () => undefined } as never,
      writeEnabled: false,
      knowledge: null,
    })

    const result = await runtime.run(() => mssqlTool.execute({
      query: "SELECT SUM(x) AS Avg_y FROM t",
    }))
    expect(typeof result).toBe("string")
    expect(result).toMatch(/aggregate-semantic mismatch/i)
  })
})

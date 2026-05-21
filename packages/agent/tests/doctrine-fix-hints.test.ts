/**
 * Doctrine fixHint discipline — every block-severity doctrine must
 * expose a canonical refactor hint, and the validator must surface it
 * in its error message so the agent sees the fix shape, not just the
 * rule it broke.
 */
import { describe, expect, it } from "vitest"
import {
    DOCTRINE_FIX_HINTS,
    enforceDoctrines,
    getDoctrineFixHint,
    MSSQL_DOCTRINES,
} from "../src/doctrine/index.js"
import { validateQuery } from "../src/tools/mssql/validation.js"

describe("doctrine fixHints", () => {
  it("registers a hint for every block-emitting doctrine code", () => {
    const queries: Record<string, string> = {
      aggregate_semantic_mismatch: "SELECT SUM(x) AS Avg_y FROM t",
      temp_table_integrity: [
        "CREATE TABLE #created_a3f91c08 (x int);",
        "SELECT * FROM #missing_a3f91c08;",
      ].join("\n"),
      temp_scalar_subquery_overused: [
        "SELECT t.k,",
        "  (SELECT COUNT(*) FROM #s_a3f91c08 s WHERE s.k = t.k) AS c1,",
        "  (SELECT SUM(v)   FROM #s_a3f91c08 s WHERE s.k = t.k) AS c2",
        "FROM #t_a3f91c08 t",
      ].join("\n"),
    }
    const emittedCodes = new Set<string>()
    for (const [code, q] of Object.entries(queries)) {
      for (const d of enforceDoctrines(q)) {
        if (d.code === code) {
          expect(d.fixHint, `${code} has a fixHint`).toBeTruthy()
          emittedCodes.add(code)
        }
      }
    }
    expect([...emittedCodes].sort()).toEqual(Object.keys(queries).sort())
  })

  it("registry getDoctrineFixHint returns the same hint as the diagnostic carries", () => {
    expect(getDoctrineFixHint("aggregate_semantic_mismatch"))
      .toBe(DOCTRINE_FIX_HINTS.aggregate_semantic_mismatch)
    expect(getDoctrineFixHint("temp_table_integrity"))
      .toBe(DOCTRINE_FIX_HINTS.temp_table_integrity)
    expect(getDoctrineFixHint("temp_scalar_subquery_overused"))
      .toBe(DOCTRINE_FIX_HINTS.temp_scalar_subquery_overused)
    expect(getDoctrineFixHint("nonexistent_code")).toBe(null)
  })

  it("validator appends the doctrine fixHint to its error string", () => {
    const aggErr = validateQuery("SELECT SUM(x) AS Avg_y FROM t", false) ?? ""
    expect(aggErr).toMatch(/aggregate-semantic mismatch/i)
    expect(aggErr).toContain("Fix:")
    expect(aggErr).toContain("match the alias")

    const tempErr = validateQuery([
      "CREATE TABLE #created_a3f91c08 (x int);",
      "SELECT * FROM #missing_a3f91c08;",
    ].join("\n"), false) ?? ""
    expect(tempErr).toMatch(/referenced without being created/i)
    expect(tempErr).toContain("Fix:")
    expect(tempErr).toMatch(/8-hex suffix|ONE query_mssql call/i)

    const scalarErr = validateQuery([
      "SELECT t.k,",
      "  (SELECT COUNT(*) FROM #s_a3f91c08 s WHERE s.k = t.k) AS c1,",
      "  (SELECT SUM(v)   FROM #s_a3f91c08 s WHERE s.k = t.k) AS c2",
      "FROM #t_a3f91c08 t",
    ].join("\n"), false) ?? ""
    expect(scalarErr).toMatch(/repeated scalar subqueries/i)
    expect(scalarErr).toContain("Fix:")
    expect(scalarErr).toMatch(/GROUP BY pkClient|JOIN that small aggregate/i)
  })

  it("every doctrine that exports enforce() owns a hint for at least one code", () => {
    // Sanity: ensure new enforcing doctrines do not slip in without a hint.
    const codesWithHints = new Set(Object.keys(DOCTRINE_FIX_HINTS))
    const seenCodes = new Set<string>()
    const probes = [
      "SELECT SUM(x) AS Avg_y FROM t",
      "SELECT * FROM publish.Revenue WITH (NOLOCK)\nSELECT * FROM publish.Revenue WITH (NOLOCK)\nSELECT * FROM publish.Revenue WITH (NOLOCK)",
      "CREATE TABLE #created_a3f91c08 (x int);\nSELECT * FROM #missing_a3f91c08;",
      [
        "SELECT t.k,",
        "  (SELECT COUNT(*) FROM #s_a3f91c08 s WHERE s.k = t.k) AS c1,",
        "  (SELECT SUM(v)   FROM #s_a3f91c08 s WHERE s.k = t.k) AS c2",
        "FROM #t_a3f91c08 t",
      ].join("\n"),
    ]
    for (const q of probes) {
      for (const d of enforceDoctrines(q)) seenCodes.add(d.code)
    }
    for (const code of seenCodes) {
      expect(codesWithHints.has(code), `code ${code} is missing from DOCTRINE_FIX_HINTS`).toBe(true)
    }
    // And every registered doctrine is reachable from the registry.
    expect(MSSQL_DOCTRINES.length).toBeGreaterThanOrEqual(5)
  })
})

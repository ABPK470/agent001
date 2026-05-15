/**
 * Tests for the MSSQL #temp-table micro-ETL allowance.
 *
 * The agent is permitted (in read-only mode) to:
 *   - CREATE / DROP / TRUNCATE / ALTER local #temp tables
 *   - INSERT / UPDATE / DELETE / MERGE / SELECT INTO local #temp tables
 *
 * The agent must STILL be blocked from:
 *   - any DDL/DML against existing schema-qualified objects (publish.*, dim.*, …)
 *   - global ##temp tables (cross-session leak)
 *   - mixed batches that touch even one real table
 *   - dangerous primitives (EXEC, OPENROWSET, BULK INSERT, DBCC, …)
 */

import { describe, expect, it } from "vitest"
import { findNonTmpMutations, validateQuery } from "../src/tools/mssql/validation.js"

const RO = false  // writeEnabled = false (read-only mode)

describe("findNonTmpMutations", () => {
  it("flags CREATE on a real table", () => {
    const offenders = findNonTmpMutations("CREATE TABLE dbo.MyTable (id int)")
    expect(offenders).toEqual([{ target: "dbo.MyTable", label: "CREATE" }])
  })

  it("ignores CREATE on a local #temp table", () => {
    expect(findNonTmpMutations("CREATE TABLE #scope (pkClient int)")).toEqual([])
  })

  it("flags CREATE on a global ##temp table", () => {
    const offenders = findNonTmpMutations("CREATE TABLE ##leaky (id int)")
    expect(offenders[0].target).toBe("##leaky")
  })

  it("ignores INSERT INTO a #temp", () => {
    expect(findNonTmpMutations("INSERT INTO #scope (pkClient) SELECT pkClient FROM dim.Client")).toEqual([])
  })

  it("flags INSERT INTO a real table", () => {
    const offenders = findNonTmpMutations("INSERT INTO publish.Revenue (x) VALUES (1)")
    expect(offenders[0]).toMatchObject({ label: "INSERT", target: "publish.Revenue" })
  })

  it("ignores DROP TABLE #temp", () => {
    expect(findNonTmpMutations("DROP TABLE #scope")).toEqual([])
  })

  it("flags DROP TABLE on a real table", () => {
    expect(findNonTmpMutations("DROP TABLE dim.Client")[0].target).toBe("dim.Client")
  })

  it("ignores SELECT INTO #temp", () => {
    expect(findNonTmpMutations("SELECT pkClient INTO #scope FROM dim.Client WHERE pkClient < 100")).toEqual([])
  })

  it("flags SELECT INTO a real table", () => {
    const offenders = findNonTmpMutations("SELECT pkClient INTO dbo.MyExtract FROM dim.Client")
    expect(offenders[0]).toMatchObject({ label: "SELECT INTO", target: "dbo.MyExtract" })
  })

  it("ignores UPDATE #temp", () => {
    expect(findNonTmpMutations("UPDATE #scope SET active = 1 WHERE pkClient = 42")).toEqual([])
  })

  it("flags UPDATE on a real table", () => {
    expect(findNonTmpMutations("UPDATE dim.Client SET Name = 'X'")[0].label).toBe("UPDATE")
  })

  it("ignores TRUNCATE #temp and CREATE INDEX on #temp", () => {
    expect(findNonTmpMutations("TRUNCATE TABLE #scope")).toEqual([])
    expect(findNonTmpMutations("CREATE INDEX ix_scope_pk ON #scope (pkClient)")).toEqual([])
  })

  it("flags a mixed batch: one stmt hits a real table", () => {
    const batch = `
      CREATE TABLE #scope (pkClient int);
      INSERT INTO #scope SELECT pkClient FROM dim.Client WHERE pkClient < 100;
      INSERT INTO publish.Revenue (x) VALUES (1);
      DROP TABLE #scope;
    `
    const offenders = findNonTmpMutations(batch)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatchObject({ label: "INSERT", target: "publish.Revenue" })
  })
})

// ── validateQuery integration ────────────────────────────────────

describe("validateQuery — #temp micro-ETL allowance (read-only mode)", () => {
  it("allows a full micro-ETL batch ending in DROP", () => {
    const batch = [
      "CREATE TABLE #scope (pkClient int);",
      "INSERT INTO #scope SELECT pkClient FROM dim.Client WHERE pkClient < 100;",
      "CREATE INDEX ix_scope_pk ON #scope (pkClient);",
      "SELECT TOP 10 r.pkClient, SUM(r.RevenueZARMTD) AS rev",
      "  FROM publish.Revenue r WITH (NOLOCK)",
      "  JOIN #scope s ON s.pkClient = r.pkClient",
      "  WHERE r.pkMonth BETWEEN 202501 AND 202512",
      "  GROUP BY r.pkClient;",
      "DROP TABLE #scope;",
    ].join("\n")
    expect(validateQuery(batch, RO)).toBeNull()
  })

  it("allows SELECT INTO #scope as the opening statement", () => {
    const q = "SELECT pkClient INTO #scope FROM dim.Client WHERE pkClient < 100;"
    expect(validateQuery(q, RO)).toBeNull()
  })

  it("blocks CREATE on a real table", () => {
    const err = validateQuery("CREATE TABLE dbo.MyExtract (id int)", RO)
    expect(err).toMatch(/non-temp object/i)
  })

  it("blocks INSERT into a real table", () => {
    const err = validateQuery("INSERT INTO publish.Revenue (x) VALUES (1)", RO)
    expect(err).toMatch(/non-temp object/i)
  })

  it("blocks UPDATE on a real table", () => {
    const err = validateQuery("UPDATE dim.Client SET Name='x' WHERE pkClient=1", RO)
    expect(err).toMatch(/non-temp object/i)
  })

  it("blocks DROP on a real table", () => {
    const err = validateQuery("DROP TABLE dim.Client", RO)
    expect(err).toMatch(/non-temp object/i)
  })

  it("blocks global ##temp tables", () => {
    const err = validateQuery("CREATE TABLE ##leaky (id int)", RO)
    expect(err).toMatch(/non-temp object/i)
  })

  it("blocks a batch where one stmt mutates a real table", () => {
    const batch = [
      "CREATE TABLE #scope (pkClient int);",
      "INSERT INTO publish.Revenue (x) VALUES (1);",
      "DROP TABLE #scope;",
    ].join("\n")
    const err = validateQuery(batch, RO)
    expect(err).toMatch(/non-temp object/i)
    expect(err).toMatch(/publish\.Revenue/i)
  })

  it("still blocks dangerous primitives (EXEC, OPENROWSET) even on #temp", () => {
    expect(validateQuery("EXEC sp_who", RO)).toMatch(/dangerous/i)
    expect(validateQuery("SELECT * FROM OPENROWSET('x','y','z')", RO)).toMatch(/dangerous/i)
  })

  it("preserves pure-SELECT path", () => {
    expect(validateQuery("SELECT TOP 5 * FROM dim.Date WHERE Year=2025", RO)).toBeNull()
  })

  it("rejects garbage that is neither read nor a known mutation opener", () => {
    expect(validateQuery("GRANT SELECT ON dim.Client TO public", RO)).toMatch(/Write operations are disabled/i)
  })
})

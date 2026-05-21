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
import { countReferencedLargeObjects, findNonTmpMutations, validateQuery, validateTempTableBatch } from "../src/tools/mssql/validation.js"

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

  it("blocks a temp-table typo that references an uncreated #temp", () => {
    const batch = [
      "SET NOCOUNT ON;",
      "SELECT pkClient INTO #topClients_6b4c9a12 FROM dim.Client WHERE pkClient < 100;",
      "SELECT pkClient INTO #balLines_6b4c9a12 FROM #topClients_6b4c9a12;",
      "SELECT COUNT(*) AS c FROM #balLines_6bc49a12;",
      "DROP TABLE #balLines_6b4c9a12;",
      "DROP TABLE #topClients_6b4c9a12;",
    ].join("\n")
    expect(validateTempTableBatch(batch)).toMatch(/referenced without being created/i)
    expect(validateQuery(batch, RO)).toMatch(/#balLines_6bc49a12/i)
  })

  it("blocks inconsistent temp suffixes across one batch", () => {
    const batch = [
      "CREATE TABLE #scope_a3f91c08 (pkClient int);",
      "CREATE TABLE #detail_b4c9a120 (pkClient int);",
      "DROP TABLE #detail_b4c9a120;",
      "DROP TABLE #scope_a3f91c08;",
    ].join("\n")
    const result = validateTempTableBatch(batch)
    expect(typeof result).toBe("string")
    expect(result ?? "").toMatch(/inconsistent #temp suffixes/i)
  })

  it("blocks malformed temp suffixes that are not 8 hex chars", () => {
    const batch = [
      "CREATE TABLE #scope_a3f91c08 (pkClient int);",
      "CREATE TABLE #detail_b4c9a12 (pkClient int);",
      "DROP TABLE #detail_b4c9a12;",
      "DROP TABLE #scope_a3f91c08;",
    ].join("\n")
    const result = validateTempTableBatch(batch)
    expect(typeof result).toBe("string")
    expect(result ?? "").toMatch(/malformed #temp suffix/i)
  })

  it("counts repeated references to large objects", () => {
    const counts = countReferencedLargeObjects([
      "SELECT * FROM publish.Revenue r1",
      "JOIN publish.Revenue r2 ON r1.pkClient = r2.pkClient",
      "JOIN publish.Revenue r3 ON r2.pkClient = r3.pkClient",
    ].join("\n"))
    expect(counts.get("publish.revenue")).toBe(3)
  })

  it("counts repeated references to persisted publish mirrors", () => {
    const counts = countReferencedLargeObjects([
      "SELECT * FROM persistedView.[publish.Revenue] r1",
      "JOIN persistedView.[publish.Revenue] r2 ON r1.pkClient = r2.pkClient",
      "JOIN persistedView.[publish.Revenue] r3 ON r2.pkClient = r3.pkClient",
    ].join("\n"))
    expect(counts.get("persistedview.publish.revenue")).toBe(3)
  })

  it("blocks referencing a large view more than twice in one batch", () => {
    const batch = [
      "SELECT TOP 10 a.pkClient",
      "FROM publish.Revenue a WITH (NOLOCK)",
      "JOIN publish.Revenue b WITH (NOLOCK) ON a.pkClient = b.pkClient",
      "JOIN publish.Revenue c WITH (NOLOCK) ON b.pkClient = c.pkClient",
      "WHERE a.pkMonth BETWEEN 202501 AND 202512",
    ].join("\n")
    expect(validateQuery(batch, RO)).toMatch(/referenced too many times/i)
    expect(validateQuery(batch, RO)).toMatch(/publish\.Revenue/i)
  })

  it("blocks unfiltered persisted publish mirrors too", () => {
    const query = "SELECT TOP 5 pkClient FROM persistedView.[publish.Revenue] ORDER BY pkClient"
    expect(validateQuery(query, RO)).toMatch(/full scan/i)
  })

  it("blocks repeated scalar probes against the same staged temp table", () => {
    const batch = [
      "SET NOCOUNT ON;",
      "SELECT pkClient, pkProduct, RevenueZARMTD INTO #revLines_a3f91c08 FROM publish.Revenue WHERE pkMonth BETWEEN 202501 AND 202512;",
      "SELECT",
      "  base.pkClient,",
      "  (SELECT COUNT(*) FROM #revLines_a3f91c08 r WHERE r.pkClient = base.pkClient) AS ProductCount,",
      "  (SELECT SUM(r.RevenueZARMTD) FROM #revLines_a3f91c08 r WHERE r.pkClient = base.pkClient) AS RevenueZAR",
      "FROM #revLines_a3f91c08 base;",
      "DROP TABLE #revLines_a3f91c08;",
    ].join("\n")
    expect(validateQuery(batch, RO)).toMatch(/repeated scalar subqueries/i)
    expect(validateQuery(batch, RO)).toMatch(/aggregate the staged #temp once per business key/i)
  })
})

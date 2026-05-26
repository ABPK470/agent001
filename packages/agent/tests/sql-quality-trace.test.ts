import { PlannerTraceKind } from "@mia/agent"
import { describe, expect, it } from "vitest"
import { readToolTraceContext } from "../src/application/shell/loop-cluster/tool-execution/trace-context.js"
import { createAgentLoopState, executeToolRound } from "../src/application/shell/loop.js"
import { emitMssqlQualityTrace } from "../src/tools/mssql/trace.js"
import { analyzeMssqlQueryQuality, validateQueryDetailed } from "../src/tools/mssql/validation.js"
import type { Tool } from "../src/domain/agent-types.js"

describe("SQL quality analysis", () => {
  it("derives structural performance heuristics without prompt hardcoding", () => {
    const query = [
      "SELECT TOP 5 r.pkClient, SUM(r.RevenueZARMTD) AS TotalRevenueZAR",
      "INTO #topClients_a3f91c08",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "WHERE r.pkMonth BETWEEN 202501 AND 202512",
      "GROUP BY r.pkClient;",
      "",
      "SELECT tc.pkClient,",
      "       (SELECT COUNT(*) FROM #topClients_a3f91c08 t2 WHERE t2.pkClient = tc.pkClient) AS ClientCount",
      "FROM #topClients_a3f91c08 tc;",
    ].join("\n")

    const analysis = analyzeMssqlQueryQuality(query)

    expect(analysis.largeObjectRefs).toEqual([{ name: "publish.revenue", count: 1 }])
    expect(analysis.missingPersistedMirrorCandidates).toEqual(["publish.revenue"])
    expect(analysis.tempTableRefs).toBe(1)
    expect(analysis.tempTablesCreated).toBe(1)
    expect(analysis.tempTableSuffixes).toEqual(["a3f91c08"])
    expect(analysis.tempScalarSubqueryCount).toBe(1)
    expect(analysis.stagePatternLikely).toBe(true)
  })

  it("blocks repeated temp scalar probes as a structural stage-3 defect", () => {
    const query = [
      "SELECT pkClient, pkProduct, RevenueZARMTD INTO #revLines_a3f91c08 FROM publish.Revenue WHERE pkMonth BETWEEN 202501 AND 202512;",
      "SELECT",
      "  base.pkClient,",
      "  (SELECT COUNT(*) FROM #revLines_a3f91c08 r WHERE r.pkClient = base.pkClient) AS ProductCount,",
      "  (SELECT SUM(r.RevenueZARMTD) FROM #revLines_a3f91c08 r WHERE r.pkClient = base.pkClient) AS RevenueZAR",
      "FROM #revLines_a3f91c08 base;",
      "DROP TABLE #revLines_a3f91c08;",
    ].join("\n")

    const validation = validateQueryDetailed(query, false)

    expect(validation.ok).toBe(false)
    expect(validation.code).toBe("temp_scalar_subquery_overused")
    expect(validation.analysis.tempScalarSubqueryCount).toBe(2)
  })

  // ── Regression: false-positive shapes observed in the 2026-05-21 run. ────
  // The earlier regex flagged every `(SELECT ... FROM #temp ...)` regardless
  // of context, blocking legitimate IN-list subqueries, derived tables and
  // CTE bodies — and trapping the agent in a doctrine loop on a correct
  // query. These tests pin the disqualification rules.

  it("does NOT count IN-list subqueries against #temp as scalar probes", () => {
    const query = [
      "SELECT pkClient INTO #topClients_b71ac2e4 FROM publish.Revenue WHERE pkMonth = 202501 GROUP BY pkClient;",
      "SELECT pkClient, pkProduct, RevenueZARMTD",
      "INTO #revLines_b71ac2e4",
      "FROM publish.Revenue WITH (NOLOCK)",
      "WHERE pkMonth = 202501",
      "  AND pkClient IN (SELECT pkClient FROM #topClients_b71ac2e4);",
      "SELECT pkClient, pkMonth, AverageCreditBalanceZARMTD",
      "INTO #balLines_b71ac2e4",
      "FROM publish.Balances WITH (NOLOCK)",
      "WHERE pkMonth = 202501",
      "  AND pkClient IN (SELECT pkClient FROM #topClients_b71ac2e4);",
      "DROP TABLE #balLines_b71ac2e4; DROP TABLE #revLines_b71ac2e4; DROP TABLE #topClients_b71ac2e4;",
    ].join("\n")

    const analysis = analyzeMssqlQueryQuality(query)
    expect(analysis.tempScalarSubqueryCount).toBe(0)
    const validation = validateQueryDetailed(query, false)
    if (!validation.ok) {
      expect(validation.code).not.toBe("temp_scalar_subquery_overused")
    }
  })

  it("does NOT count CTE bodies that read from #temp as scalar probes", () => {
    const query = [
      "SELECT pkClient, pkProduct, RevenueZARMTD INTO #revLines_x FROM publish.Revenue WHERE pkMonth = 202501;",
      "WITH revClient AS (",
      "  SELECT pkClient, SUM(RevenueZARMTD) AS Revenue FROM #revLines_x GROUP BY pkClient",
      "),",
      "prodRank AS (",
      "  SELECT pkClient, pkProduct, SUM(RevenueZARMTD) AS Revenue,",
      "         ROW_NUMBER() OVER (PARTITION BY pkClient ORDER BY SUM(RevenueZARMTD) DESC) AS rn",
      "  FROM #revLines_x GROUP BY pkClient, pkProduct",
      ")",
      "SELECT rc.pkClient, rc.Revenue, pr.pkProduct",
      "FROM revClient rc LEFT JOIN prodRank pr ON pr.pkClient = rc.pkClient AND pr.rn = 1;",
      "DROP TABLE #revLines_x;",
    ].join("\n")

    const analysis = analyzeMssqlQueryQuality(query)
    expect(analysis.tempScalarSubqueryCount).toBe(0)
  })

  it("does NOT count derived tables that read from #temp as scalar probes", () => {
    const query = [
      "SELECT pkClient INTO #t FROM publish.Revenue WHERE pkMonth = 202501 GROUP BY pkClient;",
      "SELECT x.pkClient, x.cnt",
      "FROM (SELECT pkClient, COUNT(*) AS cnt FROM #t GROUP BY pkClient) x;",
      "DROP TABLE #t;",
    ].join("\n")

    const analysis = analyzeMssqlQueryQuality(query)
    expect(analysis.tempScalarSubqueryCount).toBe(0)
  })

  it("does NOT count EXISTS subqueries against #temp as scalar probes", () => {
    const query = [
      "SELECT pkClient INTO #t FROM publish.Revenue WHERE pkMonth = 202501 GROUP BY pkClient;",
      "SELECT c.pkClient, c.ClientName",
      "FROM publish.Client c WITH (NOLOCK)",
      "WHERE EXISTS (SELECT 1 FROM #t WHERE #t.pkClient = c.pkClient);",
      "DROP TABLE #t;",
    ].join("\n")

    const analysis = analyzeMssqlQueryQuality(query)
    expect(analysis.tempScalarSubqueryCount).toBe(0)
  })

  it("DOES count correlated single-column scalar aggregates in the SELECT list", () => {
    const query = [
      "SELECT pkClient, pkProduct, RevenueZARMTD INTO #r FROM publish.Revenue WHERE pkMonth = 202501;",
      "SELECT base.pkClient,",
      "       (SELECT SUM(r.RevenueZARMTD) FROM #r r WHERE r.pkClient = base.pkClient) AS Revenue,",
      "       (SELECT COUNT(*) FROM #r r WHERE r.pkClient = base.pkClient) AS Lines",
      "FROM #r base;",
      "DROP TABLE #r;",
    ].join("\n")

    const analysis = analyzeMssqlQueryQuality(query)
    expect(analysis.tempScalarSubqueryCount).toBe(2)
    const validation = validateQueryDetailed(query, false)
    expect(validation.ok).toBe(false)
    expect(validation.code).toBe("temp_scalar_subquery_overused")
  })
})

// Branch-aggregation guard for publish.Revenue / publish.Balances. The
// 2026-05-21 cancelled run had the agent emit Stage 1 as a direct
// `SELECT TOP 5 ... FROM publish.Revenue GROUP BY pkClient` — that always
// times out because it forces global expansion of the 59-branch UNION.
describe("publish.Revenue / publish.Balances branch-aggregation guard", () => {
  it("BLOCKS direct TOP-N + GROUP BY pkClient against publish.Revenue", () => {
    const query = [
      "SELECT TOP 5",
      "    r.pkClient,",
      "    SUM(r.RevenueZARMTD) AS TotalRevenueZAR",
      "INTO #topClients_8e5a1c2f",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "WHERE r.pkMonth BETWEEN 202501 AND 202501",
      "  AND r.pkClient IS NOT NULL",
      "GROUP BY r.pkClient",
      "ORDER BY SUM(r.RevenueZARMTD) DESC, r.pkClient;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    expect(v.ok).toBe(false)
    expect(v.code).toBe("publish_view_topn_without_branch_aggregation")
    expect(v.error ?? "").toContain("publish.Revenue")
    expect(v.error ?? "").toContain("pkClient")
    expect(v.error ?? "").toContain("Fix:")
    expect(v.lesson?.subject).toMatch(/^doctrine:publish-view-topn-branch-agg:/)
  })

  it("BLOCKS direct TOP-N + GROUP BY pkAccount against publish.Balances", () => {
    const query = [
      "SELECT TOP 10 b.pkAccount, AVG(b.AverageCreditBalanceZARMTD) AS AvgBal",
      "FROM publish.Balances b WITH (NOLOCK)",
      "WHERE b.pkMonth = 202501",
      "GROUP BY b.pkAccount",
      "ORDER BY AVG(b.AverageCreditBalanceZARMTD) DESC, b.pkAccount;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    expect(v.ok).toBe(false)
    expect(v.code).toBe("publish_view_topn_without_branch_aggregation")
    expect(v.error ?? "").toContain("publish.Balances")
  })

  it("ALLOWS the per-branch UNION ALL skeleton — the correct shape", () => {
    const query = [
      "SELECT TOP 5 x.pkClient, SUM(x.RevenueZAR) AS RevenueZAR",
      "INTO #topClients_a3f91c08",
      "FROM (",
      "    SELECT pkClient, SUM(RevenueZARMTD) AS RevenueZAR",
      "    FROM publish.MappingTransactionalBankingRules WITH (NOLOCK)",
      "    WHERE pkMonth BETWEEN 202501 AND 202501",
      "    GROUP BY pkClient",
      "    UNION ALL",
      "    SELECT pkClient, SUM(RevenueZARMTD) AS RevenueZAR",
      "    FROM publish.MappingUNOTranspose WITH (NOLOCK)",
      "    WHERE pkMonth BETWEEN 202501 AND 202501",
      "    GROUP BY pkClient",
      ") x",
      "GROUP BY x.pkClient",
      "ORDER BY SUM(x.RevenueZAR) DESC, x.pkClient;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    if (!v.ok) {
      // Other guards may still complain (e.g. write_disabled if there's an
      // INTO without a preceding CREATE batch context) — but the branch-agg
      // guard specifically must NOT fire on the per-branch UNION shape.
      expect(v.code).not.toBe("publish_view_topn_without_branch_aggregation")
    }
  })

  it("ALLOWS Stage 2: SELECT INTO from publish.Revenue with WHERE IN #topClients (no TOP/GROUP)", () => {
    const query = [
      "SELECT r.pkClient, r.pkProduct, r.pkAccount, r.pkMonth, r.RevenueZARMTD",
      "INTO #revLines_8e5a1c2f",
      "FROM publish.Revenue r WITH (NOLOCK)",
      "JOIN #range_8e5a1c2f rg ON r.pkMonth BETWEEN rg.pkMonthFrom AND rg.pkMonthTo",
      "WHERE r.pkClient IN (SELECT pkClient FROM #topClients_8e5a1c2f);",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    if (!v.ok) {
      expect(v.code).not.toBe("publish_view_topn_without_branch_aggregation")
    }
  })

  it("ALLOWS GROUP BY pkMonth (low cardinality) against publish.Revenue", () => {
    const query = [
      "SELECT TOP 12 pkMonth, SUM(RevenueZARMTD) AS RevenueZAR",
      "FROM publish.Revenue WITH (NOLOCK)",
      "WHERE pkMonth BETWEEN 202501 AND 202512",
      "GROUP BY pkMonth",
      "ORDER BY pkMonth;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    if (!v.ok) {
      expect(v.code).not.toBe("publish_view_topn_without_branch_aggregation")
    }
  })

  it("ALLOWS narrowing join from a #temp on the same group key (the safe pattern)", () => {
    // The temp's small pkClient set pushes down to each UNION branch — this
    // is exactly the pre-filter pattern the doctrine encourages, just
    // expressed as a one-shot batch instead of two stages.
    const query = [
      "CREATE TABLE #scope_a1b2c3d4 (pkClient int);",
      "INSERT INTO #scope_a1b2c3d4 SELECT pkClient FROM dim.Client WHERE Status='Active';",
      "SELECT TOP 5 r.pkClient, SUM(r.RevenueZARMTD) AS rev",
      "  FROM publish.Revenue r WITH (NOLOCK)",
      "  JOIN #scope_a1b2c3d4 s ON s.pkClient = r.pkClient",
      "  WHERE r.pkMonth BETWEEN 202501 AND 202512",
      "  GROUP BY r.pkClient",
      "  ORDER BY SUM(r.RevenueZARMTD) DESC;",
      "DROP TABLE #scope_a1b2c3d4;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    if (!v.ok) {
      expect(v.code).not.toBe("publish_view_topn_without_branch_aggregation")
    }
  })
})

// AVG(COALESCE(col, 0)) silently understates averages. Observed in the
// 2026-05-21 trace on 6 balance columns simultaneously.
describe("AVG(COALESCE/ISNULL(col, 0)) statistical guard", () => {
  it("BLOCKS AVG(COALESCE(col, 0))", () => {
    const query = [
      "SELECT pkClient,",
      "  AVG(COALESCE(b.AverageCreditBalanceZARMTD, 0)) AS AvgCreditBal",
      "FROM #balLines_x b",
      "GROUP BY pkClient;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    expect(v.ok).toBe(false)
    expect(v.code).toBe("avg_of_coalesce_zero")
    expect(v.error ?? "").toContain("Fix:")
    expect(v.lesson?.subject).toMatch(/^doctrine:avg-of-coalesce-zero:/)
  })

  it("BLOCKS AVG(ISNULL(col, 0)) (the T-SQL synonym)", () => {
    const query = "SELECT AVG(ISNULL(b.SpotCreditBalanceZARMTD, 0)) AS AvgSpot FROM #b b;"
    const v = validateQueryDetailed(query, false)
    expect(v.ok).toBe(false)
    expect(v.code).toBe("avg_of_coalesce_zero")
  })

  it("ALLOWS plain AVG(col) (the correct shape — AVG already skips NULLs)", () => {
    const query = "SELECT AVG(b.AverageCreditBalanceZARMTD) AS AvgCreditBal FROM #b b;"
    const v = validateQueryDetailed(query, false)
    if (!v.ok) expect(v.code).not.toBe("avg_of_coalesce_zero")
  })

  it("ALLOWS COALESCE(col, 0) outside an AVG aggregate", () => {
    const query = [
      "SELECT pkClient,",
      "  SUM(COALESCE(b.RevenueZARMTD, 0)) AS TotalRevenue",  // explicit zero-fill in SUM is OK
      "FROM #r b GROUP BY pkClient;",
    ].join("\n")
    const v = validateQueryDetailed(query, false)
    if (!v.ok) expect(v.code).not.toBe("avg_of_coalesce_zero")
  })

  it("ALLOWS AVG(COALESCE(col, otherCol)) — non-zero fallback is a real fallback", () => {
    const query = "SELECT AVG(COALESCE(b.SpotCreditBalanceZARMTD, b.AverageCreditBalanceZARMTD)) AS AvgBal FROM #b b;"
    const v = validateQueryDetailed(query, false)
    if (!v.ok) expect(v.code).not.toBe("avg_of_coalesce_zero")
  })
})

describe("SQL quality trace emission", () => {
  it("emits planner-sql-quality into onPlannerTrace from a tool round", async () => {
    const plannerTrace: Array<Record<string, unknown>> = []
    const query = "SELECT TOP 5 pkClient FROM publish.Revenue ORDER BY pkClient"

    const tracingQueryTool: Tool = {
      name: "query_mssql",
      description: "test double",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute(args) {
        const sql = String(args.query)
        const validation = validateQueryDetailed(sql, false)
        const toolTrace = readToolTraceContext(args)
        emitMssqlQualityTrace({
          toolMode: "query",
          phase: validation.ok ? "executed" : "blocked",
          query: sql,
          connection: "default",
          validation,
        }, toolTrace)
        return validation.error ?? "ok"
      },
    }

    const state = createAgentLoopState(3)
    const messages: Array<{ role: "tool" | "system" | "assistant" | "user"; content: string | null; toolCallId?: string; section?: "history" | "user" | "system_anchor" | "system_runtime" | "memory_working" | "memory_episodic" | "memory_semantic" }> = []

    await executeToolRound([
      { id: "tc-sql", name: "query_mssql", arguments: { query } },
    ], {
      tools: new Map([[tracingQueryTool.name, tracingQueryTool]]),
      toolList: [tracingQueryTool],
      state,
      messages,
      config: {
        signal: undefined,
        toolKillManager: undefined,
        onPlannerTrace: (entry) => plannerTrace.push(entry),
        verbose: false,
      },
      iteration: 2,
      allToolCalls: [],
    })

    expect(plannerTrace).toHaveLength(1)
    expect(plannerTrace[0]).toMatchObject({
      kind: PlannerTraceKind.SqlQuality,
      toolCallId: "tc-sql",
      toolName: "query_mssql",
      iteration: 2,
      toolMode: "query",
      phase: "blocked",
      validationOk: false,
      validationCode: "unsafe_large_object_scan",
      missingPersistedMirrorCandidates: ["publish.revenue"],
      sqlLength: query.length,
    })
    expect(plannerTrace[0]["largeObjectRefs"]).toEqual([{ name: "publish.revenue", count: 1 }])
  })
})
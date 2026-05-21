import { PlannerTraceKind } from "@mia/agent"
import { describe, expect, it } from "vitest"
import { createAgentLoopState, executeToolRound } from "../src/loop/index.js"
import { emitMssqlQualityTrace } from "../src/tools/mssql/trace.js"
import { analyzeMssqlQueryQuality, validateQueryDetailed } from "../src/tools/mssql/validation.js"
import type { Tool } from "../src/types.js"

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
        emitMssqlQualityTrace({
          toolMode: "query",
          phase: validation.ok ? "executed" : "blocked",
          query: sql,
          connection: "default",
          validation,
        })
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
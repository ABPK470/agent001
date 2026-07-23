import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-tool-result-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setupDb() {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  return await import("../src/runtime/execution/tool-result-persister.js")
}

const THREAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const UPN = "pka@corp"

function seedThreadAndRuns(runIds: string[]): void {
  testDb.prepare(`INSERT OR IGNORE INTO users (upn, display_name, is_admin, source) VALUES (?, ?, 0, 'local')`).run(
    UPN,
    UPN
  )
  testDb
    .prepare(
      `INSERT OR IGNORE INTO threads (id, upn, title, created_at, updated_at, archived_at, pinned)
       VALUES (?, ?, 'Test', datetime('now'), datetime('now'), NULL, 0)`
    )
    .run(THREAD_ID, UPN)
  for (const runId of runIds) {
    testDb
      .prepare(
        `INSERT OR REPLACE INTO runs (id, goal, status, answer, step_count, error, parent_run_id, created_at, completed_at, thread_id, upn, display_name)
         VALUES (?, 'goal', 'completed', NULL, 1, NULL, NULL, datetime('now'), datetime('now'), ?, ?, ?)`
      )
      .run(runId, THREAD_ID, UPN, UPN)
  }
}

async function loadPriorResultsForThread() {
  const { loadPriorResults } = await import("../src/runtime/prompting/data-blocks/prior-results-block.js")
  return loadPriorResults({ threadId: THREAD_ID, upn: UPN })
}

describe("persistToolResult", () => {
  it("writes captured tool results to tool_results", async () => {
    const { persistToolResult } = await setupDb()

    const ok = persistToolResult({
      runId: "run-1",
      upn: "pka",
      goal: "find top products by revenue",
      iteration: 1,
      toolCallId: "tc-1",
      toolName: "query_mssql",
      args: { query: "SELECT 1" },
      result: [
        "| Product | Revenue |",
        "|---|---:|",
        "| FX CURRENCY FORWARD | 11,702,943.16 |",
        "| CASH FEES LCY | 8,601,480.91 |"
      ].join("\n"),
      isError: false
    })

    expect(ok).toBe(true)
    const row = testDb
      .prepare("SELECT run_id, tool_call_id, tool_name, row_count FROM tool_results")
      .get() as {
      run_id: string
      tool_call_id: string
      tool_name: string
      row_count: number
    }
    expect(row).toMatchObject({
      run_id: "run-1",
      tool_call_id: "tc-1",
      tool_name: "query_mssql",
      row_count: 2
    })
  })

  it("stores an episodic referable artifact for successful tabular results", async () => {
    const { persistToolResult } = await setupDb()

    persistToolResult({
      runId: "run-2",
      upn: "pka",
      goal: "which product out of these 10 brings the least revenue",
      iteration: 1,
      toolCallId: "tc-2",
      toolName: "query_mssql",
      args: { query: "SELECT Product, Revenue FROM #top10" },
      result: [
        "| Product | Revenue |",
        "|---|---:|",
        "| FX CURRENCY FORWARD | 11,702,943.16 |",
        "| CASH FEES LCY | 8,601,480.91 |",
        "| FX CURRENCY SPOT | 2,548,999.07 |"
      ].join("\n"),
      isError: false
    })

    const artifact = testDb
      .prepare(
        `SELECT tier, role, source, upn, run_id, content, metadata
       FROM memory_entries WHERE json_extract(metadata, '$.type') = 'referable_artifact'`
      )
      .get() as {
      tier: string
      role: string
      source: string
      upn: string
      run_id: string
      content: string
      metadata: string
    }

    expect(artifact.tier).toBe("episodic")
    expect(artifact.role).toBe("summary")
    expect(artifact.source).toBe("tool")
    expect(artifact.upn).toBe("pka")
    expect(artifact.run_id).toBe("run-2")
    expect(artifact.content).toContain("[artifact:data_result]")
    expect(artifact.content).toContain("FX CURRENCY FORWARD")
    expect(artifact.content).toContain("CASH FEES LCY")
    expect(artifact.content).toContain("rows=3")

    const meta = JSON.parse(artifact.metadata) as Record<string, unknown>
    expect(meta["toolCallId"]).toBe("tc-2")
    expect(meta["toolName"]).toBe("query_mssql")
    expect(meta["type"]).toBe("referable_artifact")
  })

  it("stores an episodic referable artifact for live query_mssql pipe tables", async () => {
    const { persistToolResult } = await setupDb()

    persistToolResult({
      runId: "run-live-shape",
      upn: "pka",
      goal: "top 10 products by 2025 revenue",
      iteration: 1,
      toolCallId: "tc-live-shape",
      toolName: "query_mssql",
      args: { query: "SELECT TOP 10 ..." },
      result: [
        "(10 rows)",
        "ProductName | RevenueZARMTD",
        "------------+--------------",
        "POS SERVICE FEE INCOME | 187192337716.08",
        "FX CURRENCY SPOT (ARO) | 60754228106.85",
        "FINANCIAL SOLUTIONS GROUP | 32242818387.04"
      ].join("\n"),
      isError: false
    })

    const toolRow = testDb
      .prepare("SELECT row_count FROM tool_results WHERE run_id = 'run-live-shape'")
      .get() as { row_count: number }
    expect(toolRow.row_count).toBe(3)

    const artifact = testDb
      .prepare(
        `SELECT content FROM memory_entries WHERE run_id = 'run-live-shape' AND json_extract(metadata, '$.type') = 'referable_artifact'`
      )
      .get() as { content: string }

    expect(artifact.content).toContain("[artifact:data_result]")
    expect(artifact.content).toContain("columns=ProductName, RevenueZARMTD")
    expect(artifact.content).toContain("POS SERVICE FEE INCOME=187192337716.08")
    expect(artifact.content).toContain("FINANCIAL SOLUTIONS GROUP=32242818387.04")
  })

  it("does not store a referable artifact for failed tool results", async () => {
    const { persistToolResult } = await setupDb()

    persistToolResult({
      runId: "run-3",
      upn: "pka",
      goal: "find top products by revenue",
      iteration: 1,
      toolCallId: "tc-3",
      toolName: "query_mssql",
      args: { query: "SELECT 1" },
      result: "Invalid object name 'publish.Missing'.",
      isError: true
    })

    const count = testDb
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_entries WHERE json_extract(metadata, '$.type') = 'referable_artifact'`
      )
      .get() as { n: number }
    expect(count.n).toBe(0)
  })

  it("does not persist governance-denied query results into tool_results", async () => {
    const { persistToolResult } = await setupDb()

    const ok = persistToolResult({
      runId: "run-4",
      upn: "pka",
      goal: "top products by revenue",
      iteration: 1,
      toolCallId: "tc-4",
      toolName: "query_mssql",
      args: { query: "SELECT TOP 10 * FROM publish.Revenue" },
      result:
        "DENIED: Policy 'hosted_default_deny' violated: no policy rule allows tool \"query_mssql\" in hosted mode. This action is forbidden by governance policy.",
      isError: false
    })

    expect(ok).toBe(false)
    const count = testDb.prepare("SELECT COUNT(*) AS n FROM tool_results WHERE run_id = 'run-4'").get() as {
      n: number
    }
    expect(count.n).toBe(0)
  })

  it("filters legacy governance-denied rows out of prior_results", async () => {
    await setupDb()
    seedThreadAndRuns(["run-denied", "run-valid"])

    testDb
      .prepare(
        `
      INSERT INTO tool_results (run_id, tool_call_id, tool_name, args_json, result_json, row_count, bytes, truncated, goal_excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `
      )
      .run(
        "run-denied",
        "tc-denied",
        "query_mssql",
        "{}",
        JSON.stringify({
          text: "DENIED: Policy 'hosted_default_deny' violated: no policy rule allows tool \"query_mssql\" in hosted mode.",
          isError: false
        }),
        null,
        120,
        0,
        "top products by revenue"
      )

    testDb
      .prepare(
        `
      INSERT INTO tool_results (run_id, tool_call_id, tool_name, args_json, result_json, row_count, bytes, truncated, goal_excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `
      )
      .run(
        "run-valid",
        "tc-valid",
        "query_mssql",
        "{}",
        JSON.stringify({
          text: "| Product | Revenue |\n|---|---:|\n| CASH FEES LCY | 8601480.91 |",
          isError: false
        }),
        1,
        82,
        0,
        "top products by revenue"
      )

    const rows = await loadPriorResultsForThread()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.run_id).toBe("run-valid")
  })
})

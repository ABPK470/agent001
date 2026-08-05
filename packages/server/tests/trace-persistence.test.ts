import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let testDb: Database.Database
let dataDir: string
const originalDataDir = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-trace-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
})

afterEach(() => {
  vi.restoreAllMocks()
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = originalDataDir
})

async function setup() {
  const { _setDb, _migrate } = await import(
    "../src/infra/persistence/adapters/sqlite/index.js"
  )
  _setDb(testDb)
  _migrate(testDb)
  const persistence = await import("../src/runtime/execution/persistence.js")
  const db = await import("../src/infra/persistence/sqlite.js")
  return { ...persistence, ...db }
}

describe("trace persistence", () => {
  it("serializes writes and flushes them in sequence order", async () => {
    const { flushTrace, getTraceEntries, saveTrace } = await setup()
    testDb.pragma("foreign_keys = OFF")

    const runId = "trace-run"
    const activeRun = {
      traceSeq: 0,
      traceWrites: Promise.resolve(),
      traceWriteError: null,
    }
    const activeRuns = new Map([[runId, activeRun]])

    saveTrace(activeRuns, runId, { kind: "thinking", text: "first" })
    saveTrace(activeRuns, runId, { kind: "thinking", text: "second" })
    saveTrace(activeRuns, runId, { kind: "answer", text: "done" })
    await flushTrace(activeRuns, runId)

    const rows = await getTraceEntries(runId)
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
    expect(rows.map((row) => JSON.parse(row.data))).toEqual([
      { kind: "thinking", text: "first" },
      { kind: "thinking", text: "second" },
      { kind: "answer", text: "done" },
    ])
  })

  it("surfaces any queued write failure at flush", async () => {
    const { flushTrace, saveTrace } = await setup()
    testDb.pragma("foreign_keys = ON")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const runId = "missing-run"
    const activeRun = {
      traceSeq: 0,
      traceWrites: Promise.resolve(),
      traceWriteError: null,
    }
    const activeRuns = new Map([[runId, activeRun]])

    await expect(
      saveTrace(activeRuns, runId, { kind: "thinking", text: "lost" }),
    ).rejects.toThrow()
    await expect(flushTrace(activeRuns, runId)).rejects.toThrow()
    expect(consoleError).toHaveBeenCalledOnce()
  })
})

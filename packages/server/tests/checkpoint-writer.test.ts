/**
 * writeRunCheckpoint — the single checkpoint write-path.
 *
 * Contract:
 *   • persists a `checkpoints` row from the live messages + broadcasts
 *     `CheckpointSaved`.
 *   • is a no-op for empty messages (never overwrites a real checkpoint
 *     with an empty one).
 *   • the latest write wins (INSERT OR REPLACE), so tool-call-granular
 *     writes produce a checkpoint that resumes from the most recent tool
 *     result — not from the last completed iteration.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EventType, type Message } from "@mia/agent"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-cp-"))
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

async function setup() {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  const { subscribeToEvents } = await import("../src/infra/events/broadcaster.js")
  const { writeRunCheckpoint } = await import(
    "../src/runtime/execution/run-executor/checkpoint-writer.js"
  )
  const db = await import("../src/infra/persistence/sqlite.js")
  return { writeRunCheckpoint, subscribeToEvents, db }
}

const RUN_ID = "run-granular-test"

function toolResultMessage(toolCallId: string, content: string): Message {
  return {
    role: "tool" as const,
    toolCallId,
    content,
    section: "history" as const
  } as Message
}

describe("writeRunCheckpoint", () => {
  it("persists a checkpoint row and broadcasts CheckpointSaved", async () => {
    const { writeRunCheckpoint, subscribeToEvents, db } = await setup()
    const events: { type: string; data: Record<string, unknown> }[] = []
    const unsub = subscribeToEvents((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }))

    const messages = [toolResultMessage("tc-1", "result-1")]
    writeRunCheckpoint({ runId: RUN_ID, messages, iteration: 3, stepCounter: 7 })

    const cp = db.getCheckpoint(RUN_ID)
    expect(cp).toBeDefined()
    expect(cp!.iteration).toBe(3)
    expect(cp!.step_counter).toBe(7)
    expect(JSON.parse(cp!.messages)).toEqual(messages)

    const saved = events.find((e) => e.type === EventType.CheckpointSaved)
    expect(saved).toBeDefined()
    expect(saved!.data).toMatchObject({ runId: RUN_ID, iteration: 3, stepCounter: 7 })

    unsub()
  })

  it("is a no-op for empty messages — never overwrites a real checkpoint with an empty one", async () => {
    const { writeRunCheckpoint, db } = await setup()

    const real = [toolResultMessage("tc-1", "result-1")]
    writeRunCheckpoint({ runId: RUN_ID, messages: real, iteration: 1, stepCounter: 1 })

    writeRunCheckpoint({ runId: RUN_ID, messages: [], iteration: 2, stepCounter: 2 })

    const cp = db.getCheckpoint(RUN_ID)
    // The empty write must NOT have clobbered the real checkpoint.
    expect(cp!.iteration).toBe(1)
    expect(JSON.parse(cp!.messages)).toEqual(real)
  })

  it("latest write wins — tool-call-granular writes leave the checkpoint at the most recent tool result", async () => {
    const { writeRunCheckpoint, db } = await setup()

    // Simulate the onToolResult cadence: a checkpoint after each tool call.
    const afterFirst = [toolResultMessage("tc-1", "result-1")]
    writeRunCheckpoint({ runId: RUN_ID, messages: afterFirst, iteration: 0, stepCounter: 0 })

    const afterSecond = [...afterFirst, toolResultMessage("tc-2", "result-2")]
    writeRunCheckpoint({ runId: RUN_ID, messages: afterSecond, iteration: 0, stepCounter: 0 })

    const cp = db.getCheckpoint(RUN_ID)
    expect(JSON.parse(cp!.messages)).toEqual(afterSecond)
    // Resume reads checkpoint.messages — it would seed the agent with BOTH
    // tool results and re-run only the in-flight (third) call, not tc-1/tc-2.
    expect(JSON.parse(cp!.messages)).toHaveLength(2)
  })
})

/**
 * Orchestrator-level test harness for thread-scoped conversation continuity.
 *
 * Mirrors run-executor.ts: retrieveContext(threadId) → ingestRunTurns(runId).
 * Each simulated turn inserts a runs row so working-memory retrieval can
 * scope by thread_id (see continuity.ts).
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface SimulatedTurn {
  runId: string
  retrievedContext: { perTier: { working: string; episodic: string; semantic: string } }
  answer: string
}

export interface TurnInputs {
  goal: string
  answer: string
  threadId: string
  upn: string
  agentId?: string | null
  trace?: Array<{ kind: string; tool?: string; text?: string }>
}

interface Fixture {
  db: Database.Database
  mem: typeof import("../../src/infra/persistence/memory/index.js")
  simulateTurn(inputs: TurnInputs): Promise<SimulatedTurn>
  retrieve(args: {
    goal: string
    threadId: string
    upn: string
    runId: string
  }): Promise<{ perTier: { working: string; episodic: string; semantic: string } }>
  cleanup(): void
}

const DEFAULT_THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

function seedThread(db: Database.Database, threadId: string, upn: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (upn, display_name, is_admin, source) VALUES (?, ?, 0, 'local')`
  ).run(upn, upn)
  db.prepare(
    `
    INSERT OR IGNORE INTO threads (id, upn, title, created_at, updated_at, archived_at, pinned)
    VALUES (?, ?, 'Test', datetime('now'), datetime('now'), NULL, 0)
  `
  ).run(threadId, upn)
}

function seedRun(
  db: Database.Database,
  runId: string,
  inputs: TurnInputs,
  status = "completed"
): void {
  seedThread(db, inputs.threadId, inputs.upn)
  const now = new Date().toISOString()
  db.prepare(
    `
    INSERT OR REPLACE INTO runs
      (id, goal, status, answer, step_count, error, parent_run_id, agent_id, created_at, completed_at, thread_id, upn, display_name)
    VALUES
      (@id, @goal, @status, NULL, 1, NULL, NULL, NULL, @created_at, @completed_at, @thread_id, @upn, @display_name)
  `
  ).run({
    id: runId,
    goal: inputs.goal,
    status,
    created_at: now,
    completed_at: status === "completed" ? now : null,
    thread_id: inputs.threadId,
    upn: inputs.upn,
    display_name: inputs.upn
  })
}

export async function buildFixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "mia-orch-fixture-"))
  const originalDataDir = process.env["MIA_DATA_DIR"]
  process.env["MIA_DATA_DIR"] = dataDir

  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = OFF")

  const { _setDb, _migrate } = await import("../../src/infra/persistence/db/index.js")
  _setDb(db)
  _migrate(db)
  db.pragma("foreign_keys = OFF")

  const mem = await import("../../src/infra/persistence/memory/index.js")

  const cleanup = (): void => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env["MIA_DATA_DIR"]
    else process.env["MIA_DATA_DIR"] = originalDataDir
  }

  async function retrieve(args: {
    goal: string
    threadId: string
    upn: string
    runId: string
  }) {
    return mem.retrieveContext(args.goal, {
      threadId: args.threadId,
      runId: args.runId,
      upn: args.upn
    })
  }

  function ingest(runId: string, inputs: TurnInputs): void {
    seedRun(db, runId, inputs)
    mem.ingestRunTurns({
      id: runId,
      goal: inputs.goal,
      answer: inputs.answer,
      status: "completed",
      agentId: inputs.agentId ?? null,
      tools: [],
      stepCount: 1,
      trace: (inputs.trace ?? []) as Array<{ kind: string; tool?: string; text?: string }>,
      upn: inputs.upn
    })
  }

  async function simulateTurn(inputs: TurnInputs): Promise<SimulatedTurn> {
    if (!inputs.threadId) throw new Error("simulateTurn: threadId is required")
    if (!inputs.upn) throw new Error("simulateTurn: upn is required")
    const runId = `run-${Math.random().toString(36).slice(2, 10)}`
    seedRun(db, runId, inputs, "running")
    const retrievedContext = await retrieve({
      goal: inputs.goal,
      threadId: inputs.threadId,
      upn: inputs.upn,
      runId
    })
    ingest(runId, inputs)
    return { runId, retrievedContext, answer: inputs.answer }
  }

  return { db, mem, simulateTurn, retrieve, cleanup }
}

export { DEFAULT_THREAD }

export function salientAnswer(goal: string): string {
  return `Configured result for the request: ${goal}. The operation completed successfully with detailed output for verification.`
}

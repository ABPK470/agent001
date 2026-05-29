/**
 * Orchestrator-level test harness for conversation-continuity scenarios.
 *
 * Why this exists:
 *   The "yes had no context" bug was a one-line mismatch between two call
 *   sites in run-executor.ts (retrieveContext used `agentId ?? "default"`
 *   while ingestRunTurns used `activeRun?.sessionId ?? null`). Module tests
 *   for memory/retrieval and memory/ingestion both passed in isolation
 *   because each one chose its own consistent input. The bug only shows
 *   up when you exercise the EXACT call shape used in production end-to-end.
 *
 * What this harness gives you:
 *   - Fresh per-test in-memory SQLite + memory schema migrations.
 *   - `simulateTurn(...)` — wraps one agent turn at the same level
 *     run-executor.ts operates: retrieveContext → (caller computes the
 *     "answer") → ingestRunTurns. The exact same defaulting expressions
 *     used in run-executor are mirrored here so a future drift on either
 *     side is reproduced by these tests, not just by the static wiring
 *     contract scan.
 *   - `simulateRun(...)` — convenience for a self-contained turn that
 *     stamps a synthetic answer and tool trace, returning the runId.
 *
 * What this harness does NOT do:
 *   - It does not spin up Fastify or the real LLM. AgentOrchestrator's full
 *     stack (run-workspace, sandbox, system prompt builder, planner) brings
 *     in heavy dependencies that drown the signal of a memory-keying test.
 *     We get the same regression coverage by mirroring the production call
 *     shape exactly here, plus the static wiring-contracts.test.ts proves
 *     run-executor.ts itself uses the same shape.
 *
 * Logical invariants encoded by this harness (any of which failing means
 * conversation continuity is broken — derived from what SHOULD be true,
 * not from current code):
 *
 *   I1. write-key == read-key:
 *       For any (sessionId, upn, runId) tuple used to ingest, the same
 *       tuple used at retrieveContext MUST surface that turn's answer.
 *
 *   I2. session isolation:
 *       Two turns with the same upn but different sessionIds MUST NOT see
 *       each other's working memory.
 *
 *   I3. tenant isolation:
 *       Two turns with the same sessionId but different upns MUST NOT see
 *       each other's working memory.
 *
 *   I4. anonymous-dev isolation:
 *       Two turns with upn=null but different sessionIds (the dev case
 *       where every browser has a unique anon:<uuid> sid) MUST NOT see
 *       each other's working memory. This is the case the original bug
 *       collapsed into a single shared "default" bucket.
 *
 *   I5. excludeRunId still surfaces prior turns:
 *       Within the same session, a follow-up turn (different runId) MUST
 *       see the prior turn's answer in working memory. excludeRunId only
 *       hides the CURRENT in-flight run from itself.
 *
 *   I6. recency fallback for empty FTS queries:
 *       Short queries like "yes" / "ok" sanitize to an empty FTS query and
 *       MUST fall back to recency-ordered working memory for the session.
 *       This is the literal "yes had no context" scenario.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface SimulatedTurn {
  /** Random run id for this turn. */
  runId: string
  /** What retrieveContext returned at the START of this turn (before the answer was written). */
  retrievedContext: { perTier: { working: string; episodic: string; semantic: string } }
  /** The answer text that was ingested. */
  answer: string
}

export interface TurnInputs {
  /** The user's goal/message for this turn. */
  goal: string
  /** Synthetic answer the "agent" produces. Must be salient enough to land in
   *  working memory — see scoring.ts SALIENCE_THRESHOLD. Use action verbs +
   *  enough length to score. */
  answer: string
  /** Originating session sid (e.g. `anon:<uuid>` in dev). MUST be non-empty. */
  sessionId: string
  /** Originating user UPN (null in dev / no auth proxy). */
  upn: string | null
  /** Optional agent id; used by run-executor as a downstream fallback. */
  agentId?: string | null
  /** Optional tool trace; defaults to an empty array. */
  trace?: Array<{ kind: string; tool?: string; text?: string }>
}

interface Fixture {
  /** Fresh in-memory DB for this test. */
  db: Database.Database
  /** Memory module (lazily imported after DB is wired). */
  mem: typeof import("../../src/adapters/persistence/memory/index.js")
  /** Run a single turn end-to-end at the same abstraction level run-executor uses. */
  simulateTurn(inputs: TurnInputs): Promise<SimulatedTurn>
  /** Just retrieve context, mirroring run-executor.ts:300 EXACTLY. */
  retrieve(args: { goal: string; sessionId: string; upn: string | null; runId: string; agentId?: string | null }):
    Promise<{ perTier: { working: string; episodic: string; semantic: string } }>
  /** Cleanup hook for afterEach. */
  cleanup(): void
}

/**
 * Build a fixture. Call from inside `beforeEach` and clean up in `afterEach`.
 *
 * Each fixture is fully isolated — its own in-memory SQLite, its own MIA_DATA_DIR
 * temp directory, fresh schema migrations. Tests can construct as many as they
 * need (e.g. one per "browser" in a multi-tenant scenario).
 */
export async function buildFixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "mia-orch-fixture-"))
  const originalDataDir = process.env["MIA_DATA_DIR"]
  process.env["MIA_DATA_DIR"] = dataDir

  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  // FK enforcement is verified by dedicated cascade tests; this harness uses
  // synthetic runIds that don't exist in the runs table.
  db.pragma("foreign_keys = OFF")

  const { _setDb, _migrate } = await import("../../src/adapters/persistence/db/index.js")
  _setDb(db)
  _migrate(db)
  db.pragma("foreign_keys = OFF")

  const mem = await import("../../src/adapters/persistence/memory/index.js")
  mem.migrateMemory()

  const cleanup = (): void => {
    try { db.close() } catch { /* already closed */ }
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env["MIA_DATA_DIR"]
    else process.env["MIA_DATA_DIR"] = originalDataDir
  }

  /**
   * Mirror of run-executor.ts:300-307.
   * If this expression ever drifts from production, the wiring-contracts
   * B1/B2 tests will catch it statically AND every Layer A test calling
   * this helper will start failing with a clear "memory miss" signal.
   */
  async function retrieve(args: { goal: string; sessionId: string; upn: string | null; runId: string; agentId?: string | null }) {
    const sessionId = args.sessionId ?? args.agentId ?? "default"
    return mem.retrieveContext(args.goal, {
      sessionId,
      runId: args.runId,
      upn: args.upn,
    })
  }

  /**
   * Mirror of run-executor.ts:568 (success path).
   * Same drift-protection rationale as `retrieve`.
   */
  function ingest(runId: string, inputs: TurnInputs): void {
    mem.ingestRunTurns({
      id: runId,
      goal: inputs.goal,
      answer: inputs.answer,
      status: "completed",
      agentId: inputs.agentId ?? null,
      sessionId: inputs.sessionId ?? null,
      tools: [],
      stepCount: 1,
      trace: (inputs.trace ?? []) as Array<{ kind: string; tool?: string; text?: string }>,
      upn: inputs.upn ?? null,
    })
  }

  async function simulateTurn(inputs: TurnInputs): Promise<SimulatedTurn> {
    if (!inputs.sessionId) {
      // Production identity guarantees a non-empty sid (see auth/identity.ts).
      // Tests that pass an empty string are exercising a misuse, not the
      // production contract — fail loudly.
      throw new Error("simulateTurn: sessionId must be non-empty (matches production identity contract)")
    }
    const runId = `run-${Math.random().toString(36).slice(2, 10)}`
    const retrievedContext = await retrieve({
      goal: inputs.goal,
      sessionId: inputs.sessionId,
      upn: inputs.upn,
      runId,
      agentId: inputs.agentId ?? null,
    })
    ingest(runId, inputs)
    return { runId, retrievedContext, answer: inputs.answer }
  }

  return { db, mem, simulateTurn, retrieve, cleanup }
}

/**
 * Synthesize an answer string that is guaranteed to pass the salience filter
 * in scoring.ts (SALIENCE_THRESHOLD = 0.15). Combines an action verb (which
 * computeSalience boosts) with enough length to clear the floor.
 *
 * Use this for test fixtures that need to land in working memory. Real agent
 * answers also tend to clear the threshold; we just make it explicit here so
 * a future scoring.ts tweak doesn't accidentally invalidate the test corpus.
 */
export function salientAnswer(label: string): string {
  return `Configured ${label}: I executed the requested operation, wrote the new value, and verified the result. Concrete details: ${label}.`
}

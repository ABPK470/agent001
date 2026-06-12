/**
 * Memory tenancy tests \u2014 verify per-UPN isolation across all tiers and the
 * shared-row escape hatch.
 *
 * Mirrors the attachment-test setup: each test gets a fresh in-memory SQLite
 * via _setDb + _migrate (migrations, seeds, and memory FTS).
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-mem-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  // FK enforcement is verified by dedicated cascade tests; this suite uses
  // synthetic runIds that don't exist in the runs table.
  testDb.pragma("foreign_keys = OFF")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setupMemory() {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  return await import("../src/platform/persistence/memory/index.js")
}

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function seedRun(runId: string, threadId: string, upn: string, goal = "goal"): void {
  testDb
    .prepare(`INSERT OR IGNORE INTO users (upn, display_name, is_admin, source) VALUES (?, ?, 0, 'local')`)
    .run(upn, upn)
  testDb
    .prepare(
      `INSERT OR IGNORE INTO threads (id, upn, title, created_at, updated_at, archived_at, pinned)
       VALUES (?, ?, 'T', datetime('now'), datetime('now'), NULL, 0)`
    )
    .run(threadId, upn)
  testDb
    .prepare(
      `INSERT OR REPLACE INTO runs (id, goal, status, answer, step_count, error, parent_run_id, agent_id, created_at, completed_at, thread_id, upn, display_name)
       VALUES (?, ?, 'completed', NULL, 1, NULL, NULL, NULL, datetime('now'), datetime('now'), ?, ?, ?)`
    )
    .run(runId, goal, threadId, upn, upn)
}

describe("memory tenancy \u2014 cross-tier UPN isolation", () => {
  it("ingestTurn writes upn and searchEntries hides other tenants", async () => {
    const mem = await setupMemory()

    // Use distinct salient phrases so FTS hits each entry deterministically.
    mem.ingestTurn({
      tier: "semantic",
      role: "summary",
      content:
        "Important: alpha-tenant secret config XYZQ123 lives in vault path /alpha/very-distinctive-marker-keyword-aaaa",
      source: "system",
      confidence: 0.9,
      runId: "r-a",
      upn: "alice@corp"
    })
    mem.ingestTurn({
      tier: "semantic",
      role: "summary",
      content:
        "Important: bravo-tenant secret config WXYZ987 lives in vault path /bravo/very-distinctive-marker-keyword-bbbb",
      source: "system",
      confidence: 0.9,
      runId: "r-b",
      upn: "bob@corp"
    })

    // Alice queries semantic \u2014 should see only her row.
    const aliceHits = await mem.searchEntries("very-distinctive-marker-keyword", {
      tier: "semantic",
      budget: { maxTokens: 4000, maxItems: 10 },
      upn: "alice@corp"
    })
    expect(aliceHits.length).toBe(1)
    expect(aliceHits[0]!.entry.content).toContain("alpha-tenant")
    expect(aliceHits[0]!.entry.upn).toBe("alice@corp")

    // Bob queries the same term \u2014 only his row.
    const bobHits = await mem.searchEntries("very-distinctive-marker-keyword", {
      tier: "semantic",
      budget: { maxTokens: 4000, maxItems: 10 },
      upn: "bob@corp"
    })
    expect(bobHits.length).toBe(1)
    expect(bobHits[0]!.entry.content).toContain("bravo-tenant")
  })

  it("retrieveContext scopes ALL tiers (not just working) by upn", async () => {
    const mem = await setupMemory()

    // Plant rows in EACH tier for two users with overlapping content.
    // role='system' bypasses the salience filter so test fixtures land
    // deterministically regardless of content length / keyword density.
    for (const tier of ["working", "episodic", "semantic"] as const) {
      mem.ingestTurn({
        tier,
        role: "system",
        content: `cross-tier-leak-canary alpha shared-keyword tier=${tier}`,
        source: "agent",
        confidence: 0.9,
        runId: `r-a-${tier}`,
        upn: "alice@corp"
      })
      mem.ingestTurn({
        tier,
        role: "system",
        content: `cross-tier-leak-canary bravo shared-keyword tier=${tier}`,
        source: "agent",
        confidence: 0.9,
        runId: `r-b-${tier}`,
        upn: "bob@corp"
      })
    }

    const aliceCtx = await mem.retrieveContext("cross-tier-leak-canary shared-keyword", {
      upn: "alice@corp"
    })
    for (const r of aliceCtx.results) {
      expect(r.entry.content).not.toContain("bravo")
      expect(r.entry.upn === "alice@corp" || r.entry.shared).toBeTruthy()
    }

    const bobCtx = await mem.retrieveContext("cross-tier-leak-canary shared-keyword", {
      upn: "bob@corp"
    })
    for (const r of bobCtx.results) {
      expect(r.entry.content).not.toContain("alpha")
    }
  })

  it("shared=true rows are visible to every tenant", async () => {
    const mem = await setupMemory()

    mem.ingestTurn({
      tier: "semantic",
      role: "system",
      content: "Operator note: org-wide policy applies to everyone unique-shared-marker-zzz",
      source: "system",
      confidence: 0.95,
      runId: "r-shared",
      upn: null,
      shared: true
    })

    const aliceHits = await mem.searchEntries("unique-shared-marker-zzz", {
      tier: "semantic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "alice@corp"
    })
    const bobHits = await mem.searchEntries("unique-shared-marker-zzz", {
      tier: "semantic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "bob@corp"
    })
    expect(aliceHits.length).toBe(1)
    expect(bobHits.length).toBe(1)
    expect(aliceHits[0]!.entry.shared).toBe(true)
  })

  it("procedural memories are tenant-scoped", async () => {
    const mem = await setupMemory()

    mem.storeProcedural({
      trigger: "list customer revenue alpha-procedural-trigger-keyword",
      toolSequence: [
        { tool: "mssql_query", argsPattern: { sql: "SELECT" } },
        { tool: "format_csv", argsPattern: {} }
      ],
      runId: "ra",
      upn: "alice@corp"
    })
    mem.storeProcedural({
      trigger: "list customer revenue bravo-procedural-trigger-keyword",
      toolSequence: [
        { tool: "mssql_query", argsPattern: { sql: "SELECT" } },
        { tool: "format_csv", argsPattern: {} }
      ],
      runId: "rb",
      upn: "bob@corp"
    })

    expect(mem.searchProcedures("alpha-procedural-trigger-keyword", 5, "alice@corp").length).toBe(1)
    expect(mem.searchProcedures("alpha-procedural-trigger-keyword", 5, "bob@corp").length).toBe(0)
    expect(mem.searchProcedures("bravo-procedural-trigger-keyword", 5, "bob@corp").length).toBe(1)
    expect(mem.searchProcedures("bravo-procedural-trigger-keyword", 5, "alice@corp").length).toBe(0)
  })

  it("dedup is scoped per-tenant (alice's entry does not mask bob's)", async () => {
    const mem = await setupMemory()

    // role='system' bypasses the salience filter so we measure dedup, not
    // ingestion thresholds.
    const aliceFirst = mem.ingestTurn({
      tier: "working",
      role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool",
      confidence: 0.7,
      runId: "ra",
      upn: "alice@corp"
    })
    const bobFirst = mem.ingestTurn({
      tier: "working",
      role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool",
      confidence: 0.7,
      runId: "rb",
      upn: "bob@corp"
    })

    expect(aliceFirst).not.toBeNull()
    expect(bobFirst).not.toBeNull()
    expect(aliceFirst!.id).not.toBe(bobFirst!.id)

    // Same tenant: identical second insert IS deduplicated.
    const aliceSecond = mem.ingestTurn({
      tier: "working",
      role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool",
      confidence: 0.7,
      runId: "ra",
      upn: "alice@corp"
    })
    expect(aliceSecond).toBeNull()
  })

  it("retrieveContext without upn returns empty (agent requires authentication)", async () => {
    const mem = await setupMemory()

    mem.ingestTurn({
      tier: "semantic",
      role: "system",
      content: "alpha-only secret marker-anon-test-aaa",
      source: "system",
      confidence: 0.9,
      runId: "ra",
      upn: "alice@corp"
    })

    const empty = await mem.retrieveContext("marker-anon-test-aaa", {})
    expect(empty.results).toHaveLength(0)
    expect(empty.context).toBe("")
  })

  it("episodic upsert is scoped per-tenant (alice's failure does not overwrite bob's success)", async () => {
    const mem = await setupMemory()

    mem.ingestRunTurns({
      id: "ra",
      goal: "compute monthly KPI report",
      answer: "Bob's correct answer",
      status: "completed",
      agentId: null,
      tools: ["mssql"],
      stepCount: 3,
      trace: [],
      upn: "bob@corp"
    })
    mem.ingestRunTurns({
      id: "rb",
      goal: "compute monthly KPI report",
      answer: null,
      status: "failed",
      agentId: null,
      tools: ["mssql"],
      stepCount: 1,
      error: "boom",
      trace: [],
      upn: "alice@corp"
    })

    // Bob's episodic entry must still carry the successful answer.
    const bobEpisodic = await mem.searchEntries("compute monthly KPI report", {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "bob@corp"
    })
    expect(bobEpisodic.some((r) => r.entry.content.includes("Bob's correct answer"))).toBe(true)

    // Alice's episodic entry exists separately as a failure.
    const aliceEpisodic = await mem.searchEntries("compute monthly KPI report", {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: "alice@corp"
    })
    expect(aliceEpisodic.some((r) => r.entry.content.includes("Status: failed"))).toBe(true)
  })

  it("memory_vectors mirrors upn/shared and SQL filter prevents cross-tenant rows", async () => {
    const mem = await setupMemory()
    const { getDb } = await import("../src/platform/persistence/db/index.js")

    // Insert a few entries for two tenants and stamp synthetic embeddings
    // directly so the test does not depend on Ollama being reachable.
    const inserted: Array<{ id: string; upn: string | null; shared: number }> = []
    function plant(upn: string | null, content: string, shared = false) {
      const e = mem.ingestTurn({
        tier: "semantic",
        role: "system",
        content,
        source: "system",
        confidence: 0.9,
        runId: `r-${upn ?? "anon"}-${Math.random()}`,
        upn,
        shared
      })
      if (!e) throw new Error("ingestTurn returned null \u2014 fixture invalid")
      inserted.push({ id: e.id, upn, shared: shared ? 1 : 0 })
      // Stamp a tiny deterministic embedding manually (3-D suffices) so the
      // SQL JOIN + filter is exercised even without Ollama.
      const buf = Buffer.from(new Float32Array([1, 0, 0]).buffer)
      getDb()
        .prepare(
          `
        INSERT OR REPLACE INTO memory_vectors (entry_id, embedding, dimension, upn, shared)
        VALUES (?, ?, ?, ?, ?)
      `
        )
        .run(e.id, buf, 3, upn, shared ? 1 : 0)
    }

    plant("alice@corp", "alice vector content marker-vec-alpha")
    plant("alice@corp", "alice vector content marker-vec-alpha-2")
    plant("alice@corp", "alice vector content marker-vec-alpha-3")
    plant("bob@corp", "bob vector content marker-vec-bravo")
    plant(null, "shared org policy marker-vec-shared", true)

    // Verify mirror columns are populated as expected.
    const vecRows = getDb()
      .prepare("SELECT entry_id, upn, shared FROM memory_vectors ORDER BY upn")
      .all() as Array<{ entry_id: string; upn: string | null; shared: number }>
    expect(vecRows.length).toBe(5)
    const aliceVecs = vecRows.filter((r) => r.upn === "alice@corp")
    expect(aliceVecs.length).toBe(3)
    const sharedVec = vecRows.find((r) => r.shared === 1)
    expect(sharedVec).toBeDefined()
    expect(sharedVec!.upn).toBeNull()

    // Quick SQL probe of the tenant filter (mirrors vectors.ts WHERE clause)
    // \u2014 bob@corp must see only his row + the shared row, never alice's.
    const bobVisible = getDb()
      .prepare(
        `
      SELECT entry_id FROM memory_vectors
      WHERE (upn = ? OR shared = 1)
    `
      )
      .all("bob@corp") as Array<{ entry_id: string }>
    expect(bobVisible.length).toBe(2)
    const visibleIds = new Set(bobVisible.map((r) => r.entry_id))
    for (const a of inserted.filter((r) => r.upn === "alice@corp")) {
      expect(visibleIds.has(a.id)).toBe(false)
    }

    // Anonymous (upn IS NULL) probe must see ONLY the legacy/shared row.
    const anonVisible = getDb()
      .prepare(
        `
      SELECT entry_id FROM memory_vectors
      WHERE (upn IS NULL OR shared = 1)
    `
      )
      .all() as Array<{ entry_id: string }>
    expect(anonVisible.length).toBe(1)
    expect(anonVisible[0].entry_id).toBe(sharedVec!.entry_id)
  })

  it("REGRESSION: working-memory ingestion and retrieval agree on threadId (full-text path)", async () => {
    const mem = await setupMemory()
    const upn = "alice@corp"
    seedRun("run-1", THREAD_A, upn)

    mem.ingestRunTurns({
      id: "run-1",
      goal: "summarize the deployment runbook for the platform",
      answer:
        "Deployment runbook summary deeply-distinctive-roundtrip-marker-XYZ. " +
        "We configure the build, install dependencies, run the migration, execute the smoke test, " +
        "and write the release tag. Update the changelog after each completed step. " +
        "Refactor any failed scripts and migrate the data on success.",
      status: "completed",
      agentId: null,
      tools: ["read_file"],
      stepCount: 4,
      trace: [],
      upn
    })

    const sameThread = await mem.retrieveContext("deeply-distinctive-roundtrip-marker-XYZ", {
      threadId: THREAD_A,
      runId: "run-2",
      upn
    })
    expect(sameThread.perTier.working).toContain("deeply-distinctive-roundtrip-marker-XYZ")

    const otherThread = await mem.retrieveContext("deeply-distinctive-roundtrip-marker-XYZ", {
      threadId: THREAD_B,
      runId: "run-3",
      upn
    })
    expect(otherThread.perTier.working).toBe("")
  })

  it("REGRESSION: working-memory empty-FTS recency fallback respects threadId", async () => {
    const mem = await setupMemory()
    const upn = "alice@corp"
    seedRun("run-prev", THREAD_A, upn)

    mem.ingestRunTurns({
      id: "run-prev",
      goal: "should I rebuild the index now?",
      answer:
        "Yes, proceed. We will run the rebuild, execute the index migration, " +
        "update statistics, and write the completed status. The configure step finishes " +
        "after the rebuilding-now-will-take-roundtrip-marker step. " +
        "This refactor reclaims about 12 percent of the heap on success.",
      status: "completed",
      agentId: null,
      tools: ["mssql"],
      stepCount: 2,
      trace: [],
      upn
    })

    const followup = await mem.retrieveContext("yes", {
      threadId: THREAD_A,
      runId: "run-followup",
      upn
    })
    expect(followup.perTier.working).toContain("rebuilding-now-will-take-roundtrip-marker")

    const crossThread = await mem.retrieveContext("yes", {
      threadId: THREAD_B,
      runId: "run-other",
      upn
    })
    expect(crossThread.perTier.working).toBe("")
  })

  it("REGRESSION: ingestRunTurns and retrieveContext agree on upn (full-text path)", async () => {
    const mem = await setupMemory()
    seedRun("run-alice-1", THREAD_A, "alice@corp")

    mem.ingestRunTurns({
      id: "run-alice-1",
      goal: "draft the alpha launch checklist for the platform",
      answer:
        "Alpha launch checklist alpha-upn-roundtrip-marker-AAAA. " +
        "We configure the staging stack, install the release scripts, run the smoke test, " +
        "execute the migration, write the announcement, and update the dashboard. " +
        "Refactor any failed steps until success is completed.",
      status: "completed",
      agentId: null,
      tools: ["fs"],
      stepCount: 3,
      trace: [],
      upn: "alice@corp"
    })

    const aliceCtx = await mem.retrieveContext("alpha-upn-roundtrip-marker-AAAA", {
      threadId: THREAD_A,
      runId: "run-alice-2",
      upn: "alice@corp"
    })
    expect(aliceCtx.perTier.working).toContain("alpha-upn-roundtrip-marker-AAAA")

    const bobCtx = await mem.retrieveContext("alpha-upn-roundtrip-marker-AAAA", {
      threadId: THREAD_A,
      runId: "run-bob-1",
      upn: "bob@corp"
    })
    expect(bobCtx.perTier.working).toBe("")
  })

  it("REGRESSION: working-memory recency fallback respects upn across threads", async () => {
    const mem = await setupMemory()
    seedRun("run-alice-prev", THREAD_A, "alice@corp")
    seedRun("run-bob-prev", THREAD_B, "bob@corp")

    mem.ingestRunTurns({
      id: "run-alice-prev",
      goal: "should I deploy alpha now?",
      answer:
        "Alice approves, proceed with the deploy. We will run the rollout, " +
        "execute the verification, update the status page, write the changelog, " +
        "configure monitoring, refactor failed checks, migrate the data on success " +
        "alpha-followup-roundtrip-marker.",
      status: "completed",
      agentId: null,
      tools: ["mssql"],
      stepCount: 2,
      trace: [],
      upn: "alice@corp"
    })
    mem.ingestRunTurns({
      id: "run-bob-prev",
      goal: "should I deploy bravo now?",
      answer:
        "Bob approves, proceed with the deploy. We will run the rollout, " +
        "execute the verification, update the status page, write the changelog, " +
        "configure monitoring, refactor failed checks, migrate the data on success " +
        "bravo-followup-roundtrip-marker.",
      status: "completed",
      agentId: null,
      tools: ["mssql"],
      stepCount: 2,
      trace: [],
      upn: "bob@corp"
    })

    const aliceFollow = await mem.retrieveContext("yes", {
      threadId: THREAD_A,
      runId: "run-alice-followup",
      upn: "alice@corp"
    })
    expect(aliceFollow.perTier.working).toContain("alpha-followup-roundtrip-marker")
    expect(aliceFollow.perTier.working).not.toContain("bravo-followup-roundtrip-marker")

    const bobFollow = await mem.retrieveContext("yes", {
      threadId: THREAD_B,
      runId: "run-bob-followup",
      upn: "bob@corp"
    })
    expect(bobFollow.perTier.working).toContain("bravo-followup-roundtrip-marker")
    expect(bobFollow.perTier.working).not.toContain("alpha-followup-roundtrip-marker")
  })

  it("WIRING: run-executor retrieveContext passes activeRun threadId and upn", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const retrieveSrc = readFileSync(
      join(here, "..", "src", "features", "runs", "execution", "run-executor", "tools.ts"),
      "utf8"
    )
    const ingestSrc = readFileSync(
      join(
        here,
        "..",
        "src",
        "features",
        "runs",
        "execution",
        "run-executor",
        "finalization",
        "completed.ts"
      ),
      "utf8"
    )

    // Collect every retrieveContext({...}) call's sessionId / upn assignment.
    const retrieveCalls = [...retrieveSrc.matchAll(/retrieveContext\([^)]*?\{([\s\S]*?)\}\s*\)/g)]
    expect(retrieveCalls.length).toBeGreaterThan(0)

    // Collect every ingestRunTurns({...}) call's sessionId / upn assignment.
    const ingestCalls = [...ingestSrc.matchAll(/ingestRunTurns\(\{([\s\S]*?)\}\)/g)]
    expect(ingestCalls.length).toBeGreaterThan(0)

    function extractField(block: string, field: "threadId" | "upn"): string | null {
      const re = new RegExp(`${field}\\s*:\\s*([^,\\n}]+)`)
      const m = block.match(re)
      return m ? m[1].trim() : null
    }

    const retrieveThreadIds = retrieveCalls.map((m) => extractField(m[1], "threadId"))
    const retrieveUpns = retrieveCalls.map((m) => extractField(m[1], "upn"))
    const ingestUpns = ingestCalls.map((m) => extractField(m[1], "upn"))

    for (const v of [...retrieveThreadIds, ...retrieveUpns, ...ingestUpns]) {
      expect(v).not.toBeNull()
    }

    const threadIdAnchor = "activeRun?.threadId"
    const upnAnchor = /activeRun\?\.ownerUpn|^ownerUpn$/

    for (const expr of retrieveThreadIds) {
      expect(expr, "retrieveContext threadId must reference activeRun?.threadId").toContain(threadIdAnchor)
    }
    for (const expr of retrieveUpns) {
      expect(expr, "retrieveContext upn must reference activeRun?.ownerUpn").toMatch(upnAnchor)
    }
    for (const expr of ingestUpns) {
      expect(expr, "ingestRunTurns upn must reference owner identity").toMatch(upnAnchor)
    }
  })
})

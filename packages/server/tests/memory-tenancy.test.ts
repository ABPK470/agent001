/**
 * Memory tenancy tests \u2014 verify per-UPN isolation across all tiers and the
 * shared-row escape hatch.
 *
 * Mirrors the attachment-test setup: each test gets a fresh in-memory SQLite
 * via _setDb + _migrate, and the memory module's migrateMemory() runs after.
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
  // _migrate re-enables foreign_keys after the hard-reset; turn it off
  // again so this suite can use synthetic runIds without seeding parents.
  // Cascade behaviour is verified by dedicated FK tests.
  testDb.pragma("foreign_keys = OFF")
  const { migrateMemory } = await import("../src/platform/persistence/memory/index.js")
  migrateMemory()
  return await import("../src/platform/persistence/memory/index.js")
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
        sessionId: "default",
        upn: "alice@corp"
      })
      mem.ingestTurn({
        tier,
        role: "system",
        content: `cross-tier-leak-canary bravo shared-keyword tier=${tier}`,
        source: "agent",
        confidence: 0.9,
        runId: `r-b-${tier}`,
        sessionId: "default",
        upn: "bob@corp"
      })
    }

    const aliceCtx = await mem.retrieveContext("cross-tier-leak-canary shared-keyword", {
      upn: "alice@corp",
      sessionId: "default"
    })
    for (const r of aliceCtx.results) {
      expect(r.entry.content).not.toContain("bravo")
      expect(r.entry.upn === "alice@corp" || r.entry.shared).toBeTruthy()
    }

    const bobCtx = await mem.retrieveContext("cross-tier-leak-canary shared-keyword", {
      upn: "bob@corp",
      sessionId: "default"
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
      sessionId: "default",
      upn: "alice@corp"
    })
    const bobFirst = mem.ingestTurn({
      tier: "working",
      role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool",
      confidence: 0.7,
      runId: "rb",
      sessionId: "default",
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
      sessionId: "default",
      upn: "alice@corp"
    })
    expect(aliceSecond).toBeNull()
  })

  it("anonymous (upn=null) callers see only legacy/shared rows, never named-user data", async () => {
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
    mem.ingestTurn({
      tier: "semantic",
      role: "system",
      content: "legacy unowned row marker-anon-test-aaa",
      source: "system",
      confidence: 0.9,
      runId: "r-legacy",
      upn: null
    })

    const anonHits = await mem.searchEntries("marker-anon-test-aaa", {
      tier: "semantic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: null
    })
    // Anonymous should see the legacy row (upn IS NULL) but NOT alice's row.
    expect(anonHits.length).toBe(1)
    expect(anonHits[0]!.entry.content).toContain("legacy unowned")
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

  it("anonymous episodic memory is scoped by sid instead of the shared null-UPN pool", async () => {
    const mem = await setupMemory()
    const { getDb } = await import("../src/platform/persistence/db/index.js")

    mem.ingestRunTurns({
      id: "anon-a",
      goal: "draft deployment checklist",
      answer: "Session A answer",
      status: "completed",
      agentId: null,
      sessionId: "sid-a",
      tools: ["fs"],
      stepCount: 2,
      trace: [],
      upn: null
    })
    mem.ingestRunTurns({
      id: "anon-b",
      goal: "draft deployment checklist",
      answer: "Session B answer",
      status: "completed",
      agentId: null,
      sessionId: "sid-b",
      tools: ["fs"],
      stepCount: 2,
      trace: [],
      upn: null
    })

    const aHits = await mem.searchEntries("draft deployment checklist", {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: null,
      sessionId: "sid-a"
    })
    const bHits = await mem.searchEntries("draft deployment checklist", {
      tier: "episodic",
      budget: { maxTokens: 4000, maxItems: 5 },
      upn: null,
      sessionId: "sid-b"
    })

    expect(aHits.length).toBe(1)
    expect(aHits[0]!.entry.content).toContain("Session A answer")
    expect(bHits.length).toBe(1)
    expect(bHits[0]!.entry.content).toContain("Session B answer")

    const stored = getDb()
      .prepare(
        `
      SELECT session_id FROM memory_entries
      WHERE tier = 'episodic' AND role = 'summary' AND substr(content, 1, ?) = ?
      ORDER BY session_id ASC
    `
      )
      .all("Goal: draft deployment checklist\n".length, "Goal: draft deployment checklist\n") as Array<{
      session_id: string | null
    }>
    expect(stored.map((row) => row.session_id)).toEqual(["sid-a", "sid-b"])
  })

  it("anonymous procedural memory is scoped by sid instead of shared across null-UPN sessions", async () => {
    const mem = await setupMemory()

    mem.storeProcedural({
      trigger: "export weekly release notes anon-proc-keyword",
      toolSequence: [
        { tool: "read_file", argsPattern: { path: "a.md" } },
        { tool: "write_file", argsPattern: {} }
      ],
      runId: "ra",
      upn: null,
      sessionId: "sid-a"
    })
    mem.storeProcedural({
      trigger: "export weekly release notes anon-proc-keyword",
      toolSequence: [
        { tool: "read_file", argsPattern: { path: "b.md" } },
        { tool: "write_file", argsPattern: {} }
      ],
      runId: "rb",
      upn: null,
      sessionId: "sid-b"
    })

    expect(mem.searchProcedures("anon-proc-keyword", 5, null, "sid-a").length).toBe(1)
    expect(mem.searchProcedures("anon-proc-keyword", 5, null, "sid-b").length).toBe(1)
    const aFirstTool = mem.searchProcedures("anon-proc-keyword", 5, null, "sid-a")[0]!.toolSequence[0]!
      .argsPattern
    const bFirstTool = mem.searchProcedures("anon-proc-keyword", 5, null, "sid-b")[0]!.toolSequence[0]!
      .argsPattern
    expect(aFirstTool).toEqual({ path: "a.md" })
    expect(bFirstTool).toEqual({ path: "b.md" })
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

  // ── Regression: write→read sessionId roundtrip ──────────────────
  //
  // Bug history: the `feat(memory): implement session-based isolation` sweep
  // (commit ae2fcd47) hardened ingestion to key working-memory rows by
  // `run.sessionId` (the cookie session), but the matching read site in
  // `orchestrator/run-executor.ts` continued passing `agentId ?? "default"`
  // into `retrieveContext`. Result: working memory was written under one key
  // and read under another, so follow-up turns like "yes" / "do it" / "now
  // exclude X" surfaced ZERO conversation context — even though the prior
  // assistant answer was sitting in the table all along.
  //
  // These tests pin the contract: whatever sessionId ingestion uses MUST be
  // the same sessionId retrieval queries with, including the empty-FTS
  // recency fallback path that one-word follow-ups always hit.
  it("REGRESSION: working-memory ingestion and retrieval agree on sessionId (full-text path)", async () => {
    const mem = await setupMemory()
    const sid = "browser-session-abc123"

    // Content is engineered to pass the salience filter (length + action
    // keywords) so we measure sessionId routing, not the unrelated salience
    // gate. computeSalience: lengthScore(0.35) + actionScore(0.40) + structureScore(0.25).
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
      sessionId: sid,
      tools: ["read_file"],
      stepCount: 4,
      trace: [],
      upn: null
    })

    // Same session, FTS-matchable goal → working memory must surface the answer.
    const sameSession = await mem.retrieveContext("deeply-distinctive-roundtrip-marker-XYZ", {
      sessionId: sid,
      runId: "run-2",
      upn: null
    })
    expect(sameSession.perTier.working).toContain("deeply-distinctive-roundtrip-marker-XYZ")

    // Different session → must NOT see it (isolation still holds).
    const otherSession = await mem.retrieveContext("deeply-distinctive-roundtrip-marker-XYZ", {
      sessionId: "different-session-zzz",
      runId: "run-3",
      upn: null
    })
    expect(otherSession.perTier.working).toBe("")
  })

  it("REGRESSION: working-memory empty-FTS recency fallback respects sessionId (the 'yes' follow-up path)", async () => {
    const mem = await setupMemory()
    const sid = "browser-session-followup"

    // Same salience-engineering as above so the row actually lands in working
    // memory. The recency-fallback path (one-word goals) does not apply FTS
    // matching, so any salient row in the same session must surface.
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
      sessionId: sid,
      tools: ["mssql"],
      stepCount: 2,
      trace: [],
      upn: null
    })

    // The exact failure mode reported by the user: a one-word follow-up.
    // sanitizeFtsQuery("yes") yields no usable FTS tokens → retrieval falls
    // back to getRecentEntries(tier, maxItems, sessionId, upn). That path
    // MUST find the prior assistant answer in the same session.
    const followup = await mem.retrieveContext("yes", {
      sessionId: sid,
      runId: "run-followup",
      upn: null
    })
    expect(followup.perTier.working).toContain("rebuilding-now-will-take-roundtrip-marker")

    // Cross-session "yes" must remain empty (no leakage between browser tabs).
    const crossSession = await mem.retrieveContext("yes", {
      sessionId: "another-session",
      runId: "run-other",
      upn: null
    })
    expect(crossSession.perTier.working).toBe("")
  })

  // ── Regression: write→read UPN roundtrip ────────────────────────
  //
  // Same bug class as the sessionId regression above, applied to the upn
  // axis. The risk: a future refactor changes which field of activeRun is
  // forwarded as `upn` at the read site (e.g. swaps `ownerUpn` for some
  // other field) without also updating ingestion. These tests pin the
  // contract that whatever upn ingestion stamps on a row MUST be the same
  // upn retrieval queries with — otherwise per-tenant memory becomes
  // invisible to its owner (under-fetch) or visible to others (leakage).
  it("REGRESSION: ingestRunTurns and retrieveContext agree on upn (full-text path)", async () => {
    const mem = await setupMemory()

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
      sessionId: "sid-alice",
      tools: ["fs"],
      stepCount: 3,
      trace: [],
      upn: "alice@corp"
    })

    // Alice retrieves with her own upn → must surface her answer.
    const aliceCtx = await mem.retrieveContext("alpha-upn-roundtrip-marker-AAAA", {
      sessionId: "sid-alice",
      runId: "run-alice-2",
      upn: "alice@corp"
    })
    expect(aliceCtx.perTier.working).toContain("alpha-upn-roundtrip-marker-AAAA")

    // Bob retrieves the same content → must NOT see Alice's row even with the
    // same sessionId, because the upn predicate isolates tenants across all tiers.
    const bobCtx = await mem.retrieveContext("alpha-upn-roundtrip-marker-AAAA", {
      sessionId: "sid-alice",
      runId: "run-bob-1",
      upn: "bob@corp"
    })
    expect(bobCtx.perTier.working).toBe("")
  })

  it("REGRESSION: working-memory recency fallback respects upn (one-word follow-up across tenants)", async () => {
    const mem = await setupMemory()

    // Two tenants share the same browser session id (same shared workstation,
    // different SSO accounts) — the recency fallback must still isolate by upn.
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
      sessionId: "shared-sid",
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
      sessionId: "shared-sid",
      tools: ["mssql"],
      stepCount: 2,
      trace: [],
      upn: "bob@corp"
    })

    // Empty-FTS recency fallback (the "yes" path) for Alice — must surface her
    // answer ONLY, never bleed Bob's content even though they share sessionId.
    const aliceFollow = await mem.retrieveContext("yes", {
      sessionId: "shared-sid",
      runId: "run-alice-followup",
      upn: "alice@corp"
    })
    expect(aliceFollow.perTier.working).toContain("alpha-followup-roundtrip-marker")
    expect(aliceFollow.perTier.working).not.toContain("bravo-followup-roundtrip-marker")

    // Mirror for Bob.
    const bobFollow = await mem.retrieveContext("yes", {
      sessionId: "shared-sid",
      runId: "run-bob-followup",
      upn: "bob@corp"
    })
    expect(bobFollow.perTier.working).toContain("bravo-followup-roundtrip-marker")
    expect(bobFollow.perTier.working).not.toContain("alpha-followup-roundtrip-marker")
  })

  // ── Wiring contract: run-executor pairs the same key on both sides ──
  //
  // Module-level roundtrip tests (above) prove the memory module behaves
  // correctly when called consistently. They CANNOT catch a regression
  // where the orchestrator call sites pick different keys — exactly the
  // bug we just shipped. This test reads run-executor.ts as text and asserts
  // the contract: ingestRunTurns(...) and retrieveContext(...) MUST be
  // called with byte-identical sessionId and upn expressions. If a future
  // refactor changes one site without the other, this fails loudly.
  it("WIRING: run-executor passes the same sessionId/upn expression to ingestRunTurns and retrieveContext", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const retrieveSrc = readFileSync(
      join(here, "..", "src", "features", "runs", "execution", "run-executor", "environment.ts"),
      "utf8"
    )
    const ingestSrc = readFileSync(
      join(here, "..", "src", "features", "runs", "execution", "run-executor", "finalization.ts"),
      "utf8"
    )

    // Collect every retrieveContext({...}) call's sessionId / upn assignment.
    const retrieveCalls = [...retrieveSrc.matchAll(/retrieveContext\([^)]*?\{([\s\S]*?)\}\s*\)/g)]
    expect(retrieveCalls.length).toBeGreaterThan(0)

    // Collect every ingestRunTurns({...}) call's sessionId / upn assignment.
    const ingestCalls = [...ingestSrc.matchAll(/ingestRunTurns\(\{([\s\S]*?)\}\)/g)]
    expect(ingestCalls.length).toBeGreaterThan(0)

    function extractField(block: string, field: "sessionId" | "upn"): string | null {
      // Match `field: <expr>,` up to the next comma or closing brace at the
      // same depth. Good enough for the simple expressions used at these sites.
      const re = new RegExp(`${field}\\s*:\\s*([^,\\n}]+)`)
      const m = block.match(re)
      return m ? m[1].trim() : null
    }

    const retrieveSessionIds = retrieveCalls.map((m) => extractField(m[1], "sessionId"))
    const retrieveUpns = retrieveCalls.map((m) => extractField(m[1], "upn"))
    const ingestSessionIds = ingestCalls.map((m) => extractField(m[1], "sessionId"))
    const ingestUpns = ingestCalls.map((m) => extractField(m[1], "upn"))

    // Every site must specify both fields explicitly — no implicit undefined
    // that would silently fall through to "default" and re-introduce the bug.
    for (const v of [...retrieveSessionIds, ...retrieveUpns, ...ingestSessionIds, ...ingestUpns]) {
      expect(v).not.toBeNull()
    }

    // The CONTRACT: at least one ingestion sessionId expression must appear
    // in the retrieval sessionId expression (and vice versa for upn). The
    // shipped fix uses `activeRun?.sessionId` on both sides; we lock that
    // anchor so future refactors that drop it will fail this test.
    const sessionIdAnchor = "activeRun?.sessionId"
    const upnAnchor = "activeRun?.ownerUpn"

    for (const expr of retrieveSessionIds) {
      expect(expr, "retrieveContext sessionId expression must reference activeRun?.sessionId").toContain(
        sessionIdAnchor
      )
    }
    for (const expr of ingestSessionIds) {
      expect(expr, "ingestRunTurns sessionId expression must reference activeRun?.sessionId").toContain(
        sessionIdAnchor
      )
    }
    for (const expr of retrieveUpns) {
      expect(expr, "retrieveContext upn expression must reference activeRun?.ownerUpn").toContain(upnAnchor)
    }
    for (const expr of ingestUpns) {
      expect(expr, "ingestRunTurns upn expression must reference activeRun?.ownerUpn").toContain(upnAnchor)
    }
  })
})

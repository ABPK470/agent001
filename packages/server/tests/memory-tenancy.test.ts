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
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setupMemory() {
  const { _setDb, _migrate } = await import("../src/db.js")
  _setDb(testDb)
  _migrate(testDb)
  const { migrateMemory } = await import("../src/memory.js")
  migrateMemory()
  return await import("../src/memory.js")
}

describe("memory tenancy \u2014 cross-tier UPN isolation", () => {
  it("ingestTurn writes upn and searchEntries hides other tenants", async () => {
    const mem = await setupMemory()

    // Use distinct salient phrases so FTS hits each entry deterministically.
    mem.ingestTurn({
      tier: "semantic", role: "summary",
      content: "Important: alpha-tenant secret config XYZQ123 lives in vault path /alpha/very-distinctive-marker-keyword-aaaa",
      source: "system", confidence: 0.9, runId: "r-a", upn: "alice@corp",
    })
    mem.ingestTurn({
      tier: "semantic", role: "summary",
      content: "Important: bravo-tenant secret config WXYZ987 lives in vault path /bravo/very-distinctive-marker-keyword-bbbb",
      source: "system", confidence: 0.9, runId: "r-b", upn: "bob@corp",
    })

    // Alice queries semantic \u2014 should see only her row.
    const aliceHits = await mem.searchEntries("very-distinctive-marker-keyword", {
      tier: "semantic", budget: { maxTokens: 4000, maxItems: 10 }, upn: "alice@corp",
    })
    expect(aliceHits.length).toBe(1)
    expect(aliceHits[0]!.entry.content).toContain("alpha-tenant")
    expect(aliceHits[0]!.entry.upn).toBe("alice@corp")

    // Bob queries the same term \u2014 only his row.
    const bobHits = await mem.searchEntries("very-distinctive-marker-keyword", {
      tier: "semantic", budget: { maxTokens: 4000, maxItems: 10 }, upn: "bob@corp",
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
        tier, role: "system",
        content: `cross-tier-leak-canary alpha shared-keyword tier=${tier}`,
        source: "agent", confidence: 0.9, runId: `r-a-${tier}`, sessionId: "default", upn: "alice@corp",
      })
      mem.ingestTurn({
        tier, role: "system",
        content: `cross-tier-leak-canary bravo shared-keyword tier=${tier}`,
        source: "agent", confidence: 0.9, runId: `r-b-${tier}`, sessionId: "default", upn: "bob@corp",
      })
    }

    const aliceCtx = await mem.retrieveContext("cross-tier-leak-canary shared-keyword", { upn: "alice@corp", sessionId: "default" })
    for (const r of aliceCtx.results) {
      expect(r.entry.content).not.toContain("bravo")
      expect(r.entry.upn === "alice@corp" || r.entry.shared).toBeTruthy()
    }

    const bobCtx = await mem.retrieveContext("cross-tier-leak-canary shared-keyword", { upn: "bob@corp", sessionId: "default" })
    for (const r of bobCtx.results) {
      expect(r.entry.content).not.toContain("alpha")
    }
  })

  it("shared=true rows are visible to every tenant", async () => {
    const mem = await setupMemory()

    mem.ingestTurn({
      tier: "semantic", role: "system",
      content: "Operator note: org-wide policy applies to everyone unique-shared-marker-zzz",
      source: "system", confidence: 0.95, runId: "r-shared", upn: null, shared: true,
    })

    const aliceHits = await mem.searchEntries("unique-shared-marker-zzz", {
      tier: "semantic", budget: { maxTokens: 4000, maxItems: 5 }, upn: "alice@corp",
    })
    const bobHits = await mem.searchEntries("unique-shared-marker-zzz", {
      tier: "semantic", budget: { maxTokens: 4000, maxItems: 5 }, upn: "bob@corp",
    })
    expect(aliceHits.length).toBe(1)
    expect(bobHits.length).toBe(1)
    expect(aliceHits[0]!.entry.shared).toBe(true)
  })

  it("procedural memories are tenant-scoped", async () => {
    const mem = await setupMemory()

    mem.storeProcedural({
      trigger: "list customer revenue alpha-procedural-trigger-keyword",
      toolSequence: [{ tool: "mssql_query", argsPattern: { sql: "SELECT" } }, { tool: "format_csv", argsPattern: {} }],
      runId: "ra", upn: "alice@corp",
    })
    mem.storeProcedural({
      trigger: "list customer revenue bravo-procedural-trigger-keyword",
      toolSequence: [{ tool: "mssql_query", argsPattern: { sql: "SELECT" } }, { tool: "format_csv", argsPattern: {} }],
      runId: "rb", upn: "bob@corp",
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
      tier: "working", role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool", confidence: 0.7, runId: "ra", sessionId: "default", upn: "alice@corp",
    })
    const bobFirst = mem.ingestTurn({
      tier: "working", role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool", confidence: 0.7, runId: "rb", sessionId: "default", upn: "bob@corp",
    })

    expect(aliceFirst).not.toBeNull()
    expect(bobFirst).not.toBeNull()
    expect(aliceFirst!.id).not.toBe(bobFirst!.id)

    // Same tenant: identical second insert IS deduplicated.
    const aliceSecond = mem.ingestTurn({
      tier: "working", role: "system",
      content: "exact same text body across users uniqueA-dedup-text-marker",
      source: "tool", confidence: 0.7, runId: "ra", sessionId: "default", upn: "alice@corp",
    })
    expect(aliceSecond).toBeNull()
  })

  it("anonymous (upn=null) callers see only legacy/shared rows, never named-user data", async () => {
    const mem = await setupMemory()

    mem.ingestTurn({
      tier: "semantic", role: "system",
      content: "alpha-only secret marker-anon-test-aaa",
      source: "system", confidence: 0.9, runId: "ra", upn: "alice@corp",
    })
    mem.ingestTurn({
      tier: "semantic", role: "system",
      content: "legacy unowned row marker-anon-test-aaa",
      source: "system", confidence: 0.9, runId: "r-legacy", upn: null,
    })

    const anonHits = await mem.searchEntries("marker-anon-test-aaa", {
      tier: "semantic", budget: { maxTokens: 4000, maxItems: 5 }, upn: null,
    })
    // Anonymous should see the legacy row (upn IS NULL) but NOT alice's row.
    expect(anonHits.length).toBe(1)
    expect(anonHits[0]!.entry.content).toContain("legacy unowned")
  })

  it("episodic upsert is scoped per-tenant (alice's failure does not overwrite bob's success)", async () => {
    const mem = await setupMemory()

    mem.ingestRunTurns({
      id: "ra", goal: "compute monthly KPI report", answer: "Bob's correct answer",
      status: "completed", agentId: null, tools: ["mssql"], stepCount: 3,
      trace: [], upn: "bob@corp",
    })
    mem.ingestRunTurns({
      id: "rb", goal: "compute monthly KPI report", answer: null,
      status: "failed", agentId: null, tools: ["mssql"], stepCount: 1,
      error: "boom", trace: [], upn: "alice@corp",
    })

    // Bob's episodic entry must still carry the successful answer.
    const bobEpisodic = await mem.searchEntries("compute monthly KPI report", {
      tier: "episodic", budget: { maxTokens: 4000, maxItems: 5 }, upn: "bob@corp",
    })
    expect(bobEpisodic.some((r) => r.entry.content.includes("Bob's correct answer"))).toBe(true)

    // Alice's episodic entry exists separately as a failure.
    const aliceEpisodic = await mem.searchEntries("compute monthly KPI report", {
      tier: "episodic", budget: { maxTokens: 4000, maxItems: 5 }, upn: "alice@corp",
    })
    expect(aliceEpisodic.some((r) => r.entry.content.includes("Status: failed"))).toBe(true)
  })

  it("memory_vectors mirrors upn/shared and SQL filter prevents cross-tenant rows", async () => {
    const mem = await setupMemory()
    const { getDb } = await import("../src/db.js")

    // Insert a few entries for two tenants and stamp synthetic embeddings
    // directly so the test does not depend on Ollama being reachable.
    const inserted: Array<{ id: string; upn: string | null; shared: number }> = []
    function plant(upn: string | null, content: string, shared = false) {
      const e = mem.ingestTurn({
        tier: "semantic", role: "system",
        content, source: "system", confidence: 0.9, runId: `r-${upn ?? "anon"}-${Math.random()}`,
        upn, shared,
      })
      if (!e) throw new Error("ingestTurn returned null \u2014 fixture invalid")
      inserted.push({ id: e.id, upn, shared: shared ? 1 : 0 })
      // Stamp a tiny deterministic embedding manually (3-D suffices) so the
      // SQL JOIN + filter is exercised even without Ollama.
      const buf = Buffer.from(new Float32Array([1, 0, 0]).buffer)
      getDb().prepare(`
        INSERT OR REPLACE INTO memory_vectors (entry_id, embedding, dimension, upn, shared)
        VALUES (?, ?, ?, ?, ?)
      `).run(e.id, buf, 3, upn, shared ? 1 : 0)
    }

    plant("alice@corp", "alice vector content marker-vec-alpha")
    plant("alice@corp", "alice vector content marker-vec-alpha-2")
    plant("alice@corp", "alice vector content marker-vec-alpha-3")
    plant("bob@corp", "bob vector content marker-vec-bravo")
    plant(null, "shared org policy marker-vec-shared", true)

    // Verify mirror columns are populated as expected.
    const vecRows = getDb().prepare("SELECT entry_id, upn, shared FROM memory_vectors ORDER BY upn").all() as Array<
      { entry_id: string; upn: string | null; shared: number }
    >
    expect(vecRows.length).toBe(5)
    const aliceVecs = vecRows.filter((r) => r.upn === "alice@corp")
    expect(aliceVecs.length).toBe(3)
    const sharedVec = vecRows.find((r) => r.shared === 1)
    expect(sharedVec).toBeDefined()
    expect(sharedVec!.upn).toBeNull()

    // Quick SQL probe of the tenant filter (mirrors vectors.ts WHERE clause)
    // \u2014 bob@corp must see only his row + the shared row, never alice's.
    const bobVisible = getDb().prepare(`
      SELECT entry_id FROM memory_vectors
      WHERE (upn = ? OR shared = 1)
    `).all("bob@corp") as Array<{ entry_id: string }>
    expect(bobVisible.length).toBe(2)
    const visibleIds = new Set(bobVisible.map((r) => r.entry_id))
    for (const a of inserted.filter((r) => r.upn === "alice@corp")) {
      expect(visibleIds.has(a.id)).toBe(false)
    }

    // Anonymous (upn IS NULL) probe must see ONLY the legacy/shared row.
    const anonVisible = getDb().prepare(`
      SELECT entry_id FROM memory_vectors
      WHERE (upn IS NULL OR shared = 1)
    `).all() as Array<{ entry_id: string }>
    expect(anonVisible.length).toBe(1)
    expect(anonVisible[0].entry_id).toBe(sharedVec!.entry_id)
  })
})

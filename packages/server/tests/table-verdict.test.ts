/**
 * Plan v3 Phase 3 — table_verdict convention on memory_entries semantic tier.
 *
 * Reuses the existing `memory_entries` table (NO schema migration). Verdicts
 * are stored with `metadata.kind="table_verdict"` and read back via
 * `listTableVerdicts({ qnames, connection })`. The newest verdict per qname
 * wins.
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
  dataDir = mkdtempSync(join(tmpdir(), "mia-tv-"))
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

async function setupMemory() {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  return await import("../src/platform/persistence/memory/index.js")
}

describe("recordTableVerdict — write path", () => {
  it("persists a verdict to the semantic tier with kind=table_verdict metadata", async () => {
    const mem = await setupMemory()
    const v = mem.recordTableVerdict({
      qname: "publish.Revenue",
      role: "canonical",
      evidence: ["fanIn=59", "incomingFK=12"],
      observedFromGoal: "list top 3 products by revenue April 2025"
    })
    expect(v.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.role).toBe("canonical")

    const row = testDb
      .prepare(`SELECT tier, content, metadata FROM memory_entries WHERE id = ?`)
      .get(v.id) as { tier: string; content: string; metadata: string }
    expect(row.tier).toBe("semantic")
    expect(row.content).toContain("[table_verdict:canonical]")
    expect(row.content).toContain("publish.Revenue")
    const meta = JSON.parse(row.metadata) as Record<string, unknown>
    expect(meta.kind).toBe("table_verdict")
    expect(meta.qname).toBe("publish.Revenue")
    expect(meta.role).toBe("canonical")
    expect(meta.evidence).toEqual(["fanIn=59", "incomingFK=12"])
    expect(meta.connection).toBe("default")
  })

  it("rejects empty qname", async () => {
    const mem = await setupMemory()
    expect(() => mem.recordTableVerdict({ qname: "", role: "canonical" })).toThrow(/qname/)
    expect(() => mem.recordTableVerdict({ qname: "   ", role: "canonical" })).toThrow(/qname/)
  })

  it("scopes verdicts by connection so cross-DB tenants do not collide", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "canonical", connection: "warehouse-prod" })
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "staging", connection: "warehouse-dev" })

    const prod = mem.listTableVerdicts({ connection: "warehouse-prod" })
    expect(prod).toHaveLength(1)
    expect(prod[0]!.role).toBe("canonical")

    const dev = mem.listTableVerdicts({ connection: "warehouse-dev" })
    expect(dev).toHaveLength(1)
    expect(dev[0]!.role).toBe("staging")
  })

  it("is additive — newer verdicts do not delete older ones", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "unknown" })
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "canonical" })
    const all = testDb
      .prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE metadata LIKE '%"kind":"table_verdict"%'`)
      .get() as { n: number }
    expect(all.n).toBe(2)
  })
})

describe("listTableVerdicts — read path", () => {
  it("returns only the newest verdict per qname", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "unknown" })
    // Bump the clock so created_at orders correctly even on fast hardware.
    await new Promise((r) => setTimeout(r, 5))
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "canonical" })

    const out = mem.listTableVerdicts({ qnames: ["publish.Revenue"] })
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe("canonical")
  })

  it("returns one row per qname when multiple qnames requested", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "canonical" })
    mem.recordTableVerdict({ qname: "publish.RevenueESGRules", role: "subset" })
    mem.recordTableVerdict({ qname: "publish.RevenueRWARules", role: "rules" })

    const out = mem.listTableVerdicts({
      qnames: ["publish.Revenue", "publish.RevenueESGRules", "publish.RevenueRWARules"]
    })
    expect(out).toHaveLength(3)
    const roles = new Map(out.map((v) => [v.qname, v.role]))
    expect(roles.get("publish.Revenue")).toBe("canonical")
    expect(roles.get("publish.RevenueESGRules")).toBe("subset")
    expect(roles.get("publish.RevenueRWARules")).toBe("rules")
  })

  it("matches qnames case-insensitively", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "canonical" })
    const out = mem.listTableVerdicts({ qnames: ["PUBLISH.REVENUE"] })
    expect(out).toHaveLength(1)
    expect(out[0]!.qname).toBe("publish.Revenue")
  })

  it("returns all verdicts (per connection) when qnames is omitted", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({ qname: "publish.Revenue", role: "canonical" })
    mem.recordTableVerdict({ qname: "publish.Balances", role: "canonical" })
    const out = mem.listTableVerdicts({})
    expect(out.map((v) => v.qname).sort()).toEqual(["publish.Balances", "publish.Revenue"])
  })

  it("returns [] when no verdicts have been recorded", async () => {
    const mem = await setupMemory()
    expect(mem.listTableVerdicts({})).toEqual([])
    expect(mem.listTableVerdicts({ qnames: ["publish.Revenue"] })).toEqual([])
  })

  it("preserves evidence and observedFromGoal in the result", async () => {
    const mem = await setupMemory()
    mem.recordTableVerdict({
      qname: "publish.Revenue",
      role: "canonical",
      evidence: ["fanIn=59", "containsBranch:publish.RevenueESGRules"],
      observedFromGoal: "top 3 products by revenue"
    })
    const [v] = mem.listTableVerdicts({ qnames: ["publish.Revenue"] })
    expect(v!.evidence).toEqual(["fanIn=59", "containsBranch:publish.RevenueESGRules"])
    expect(v!.observedFromGoal).toBe("top 3 products by revenue")
  })
})

/**
 * Tests for the resolved_terms_cache org-wide learned-mappings store.
 *
 * Mirrors the in-memory SQLite + `_setDb`/`_migrate` pattern from
 * tool-knowledge.test.ts. The store is org-wide (no upn filter on reads),
 * connection-scoped, newest-per-term wins.
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
  dataDir = mkdtempSync(join(tmpdir(), "mia-rt-"))
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
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  testDb.pragma("foreign_keys = OFF")
  return await import("../src/infra/persistence/memory/index.js")
}

describe("resolved_terms_cache — save + list", () => {
  it("returns an empty list when nothing has been written", async () => {
    const mem = await setupMemory()
    expect(mem.listResolvedTerms({ connection: "default" })).toEqual([])
  })

  it("saves a mapping and a subsequent list returns it", async () => {
    const mem = await setupMemory()
    mem.saveResolvedTerm({
      term: "clients",
      qname: "dim.Client",
      connection: "default",
      upn: "alice@corp",
      now: 1_000_000_000_000
    })
    const rows = mem.listResolvedTerms({ connection: "default", now: 1_000_000_000_001 })
    expect(rows).toHaveLength(1)
    expect(rows[0].term).toBe("clients")
    expect(rows[0].qname).toBe("dim.Client")
    expect(rows[0].createdByUpn).toBe("alice@corp")
  })

  it("lowercases the term on save so lookups are case-insensitive", async () => {
    const mem = await setupMemory()
    mem.saveResolvedTerm({ term: "Clients", qname: "dim.Client", now: 1 })
    const rows = mem.listResolvedTerms({ connection: "default" })
    expect(rows[0].term).toBe("clients")
  })

  it("a newer answer for the same term overrides the older one (newest per term wins)", async () => {
    const mem = await setupMemory()
    mem.saveResolvedTerm({ term: "clients", qname: "dim.Client", now: 1_000 })
    mem.saveResolvedTerm({ term: "clients", qname: "archive.ClientOld", now: 2_000 })
    const rows = mem.listResolvedTerms({ connection: "default", now: 3_000 })
    expect(rows).toHaveLength(1)
    expect(rows[0].qname).toBe("archive.ClientOld")
  })

  it("scopes by connection — a mapping saved on 'uat' is invisible to 'default'", async () => {
    const mem = await setupMemory()
    mem.saveResolvedTerm({ term: "clients", qname: "uatdim.Client", connection: "uat", now: 1 })
    mem.saveResolvedTerm({ term: "clients", qname: "dim.Client", connection: "default", now: 2 })
    expect(mem.listResolvedTerms({ connection: "default" })).toHaveLength(1)
    expect(mem.listResolvedTerms({ connection: "uat" })[0].qname).toBe("uatdim.Client")
  })

  it("ignores empty term/qname", async () => {
    const mem = await setupMemory()
    mem.saveResolvedTerm({ term: "  ", qname: "dim.Client", now: 1 })
    mem.saveResolvedTerm({ term: "clients", qname: "  ", now: 1 })
    expect(mem.listResolvedTerms({ connection: "default" })).toEqual([])
  })

  it("prune drops mappings older than the cutoff", async () => {
    const mem = await setupMemory()
    mem.saveResolvedTerm({ term: "old", qname: "dim.Client", now: 1_000 })
    mem.saveResolvedTerm({ term: "new", qname: "dim.Account", now: 5_000 })
    const removed = mem.pruneResolvedTerms({ maxAgeMs: 2_000, now: 5_000 })
    expect(removed).toBe(1)
    const rows = mem.listResolvedTerms({ connection: "default", now: 5_000 })
    expect(rows.map((r) => r.term)).toEqual(["new"])
  })
})

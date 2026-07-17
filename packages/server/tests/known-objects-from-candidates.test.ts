/**
 * Plan v3 Phase 4 — `loadCandidateVerdicts` + verdicts surfaced inside
 * `<known_objects>`. Exercises:
 *   - synthetic search_catalog over a stub catalog
 *   - lookup against semantic-memory `table_verdict` rows
 *   - merge into the rendered block (rows + verdicts sub-section)
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { recordTableVerdict } from "../src/infra/persistence/memory/index.js"
import {
  loadCandidateVerdicts,
  renderKnownObjectsBlock
} from "../src/api/runs/prompting/data-blocks/known-objects.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-cv-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = OFF")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

/** Minimal stub honouring the `catalog.search(goal, k)` contract. */
function stubCatalog(hits: string[]) {
  return {
    search(_q: string, limit?: number) {
      const sliced = typeof limit === "number" ? hits.slice(0, limit) : hits
      return sliced.map((qname) => ({ table: { qualifiedName: qname } }))
    }
  }
}

describe("loadCandidateVerdicts", () => {
  it("returns [] when no catalog is provided", () => {
    const out = loadCandidateVerdicts({ goal: "revenue", catalog: null })
    expect(out).toEqual([])
  })

  it("returns [] when catalog yields no hits", () => {
    const out = loadCandidateVerdicts({ goal: "revenue", catalog: stubCatalog([]) })
    expect(out).toEqual([])
  })

  it("returns [] when there are no verdicts for the candidates", () => {
    const out = loadCandidateVerdicts({
      goal: "revenue",
      catalog: stubCatalog(["publish.Revenue", "publish.RevenueESGRules"])
    })
    expect(out).toEqual([])
  })

  it("surfaces verdicts for candidates that have them, in catalog rank order", () => {
    recordTableVerdict({
      qname: "publish.Revenue",
      role: "canonical",
      evidence: ["59-branch UNION"],
      observedFromGoal: "revenue by month"
    })
    recordTableVerdict({
      qname: "publish.RevenueESGRules",
      role: "subset",
      evidence: ["1-branch ESG-only"],
      observedFromGoal: "revenue by month"
    })
    const out = loadCandidateVerdicts({
      goal: "revenue",
      catalog: stubCatalog(["publish.Revenue", "publish.RevenueESGRules"])
    })
    expect(out.map((v) => v.qname)).toEqual(["publish.Revenue", "publish.RevenueESGRules"])
    expect(out[0]?.role).toBe("canonical")
    expect(out[1]?.role).toBe("subset")
    expect(out[0]?.evidence).toContain("59-branch UNION")
  })

  it("matches qname case-insensitively", () => {
    recordTableVerdict({
      qname: "publish.Revenue",
      role: "canonical",
      evidence: ["wide"],
      observedFromGoal: "x"
    })
    const out = loadCandidateVerdicts({
      goal: "revenue",
      catalog: stubCatalog(["PUBLISH.REVENUE"])
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe("canonical")
  })

  it("returns the newest verdict per qname (latest wins)", async () => {
    recordTableVerdict({
      qname: "publish.Revenue",
      role: "subset",
      evidence: ["initial mistake"],
      observedFromGoal: "x"
    })
    // Tiny gap so the second insert has a strictly-later ISO created_at;
    // ORDER BY created_at DESC then puts it first.
    await new Promise((r) => setTimeout(r, 5))
    recordTableVerdict({
      qname: "publish.Revenue",
      role: "canonical",
      evidence: ["corrected"],
      observedFromGoal: "y"
    })
    const out = loadCandidateVerdicts({
      goal: "revenue",
      catalog: stubCatalog(["publish.Revenue"])
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe("canonical")
  })

  it("respects the k limit", () => {
    recordTableVerdict({
      qname: "publish.A",
      role: "canonical",
      evidence: [],
      observedFromGoal: "x"
    })
    recordTableVerdict({
      qname: "publish.B",
      role: "subset",
      evidence: [],
      observedFromGoal: "x"
    })
    const out = loadCandidateVerdicts({
      goal: "revenue",
      catalog: stubCatalog(["publish.A", "publish.B"]),
      k: 1
    })
    // catalog.search receives k=1 → only first qname considered.
    expect(out.map((v) => v.qname)).toEqual(["publish.A"])
  })

  it("survives a throwing catalog.search (returns [])", () => {
    const out = loadCandidateVerdicts({
      goal: "revenue",
      catalog: {
        search: () => {
          throw new Error("boom")
        }
      }
    })
    expect(out).toEqual([])
  })
})

describe("renderKnownObjectsBlock — with verdicts", () => {
  it("renders ONLY the verdicts sub-section when no cached rows", () => {
    const block = renderKnownObjectsBlock(
      [],
      [{ qname: "publish.Revenue", role: "canonical", evidence: ["59-branch UNION"] }]
    )
    expect(block).toMatch(/^<known_objects>/)
    expect(block).toContain("DURABLE TABLE VERDICTS")
    expect(block).toContain("publish.Revenue | canonical | 59-branch UNION")
    expect(block).not.toContain("tool_knowledge")
    expect(block).toMatch(/<\/known_objects>$/)
  })

  it("renders BOTH cached rows and verdicts in a single block", () => {
    const rows = [{ qname: "publish.Revenue", tool: "profile_data", mode: "fast", ageHours: 2, bytes: 1234 }]
    const verdicts = [
      { qname: "publish.Revenue", role: "canonical" as const, evidence: ["UNION"] },
      { qname: "publish.RevenueESGRules", role: "subset" as const, evidence: ["1-branch"] }
    ]
    const block = renderKnownObjectsBlock(rows, verdicts)
    expect(block).toContain("publish.Revenue | profile_data | fast | 2h | 1234B")
    expect(block).toContain("DURABLE TABLE VERDICTS")
    expect(block).toContain("publish.Revenue | canonical | UNION")
    expect(block).toContain("publish.RevenueESGRules | subset | 1-branch")
  })

  it('returns "" when both arrays are empty', () => {
    expect(renderKnownObjectsBlock([], [])).toBe("")
  })

  it("renders an em-dash when evidence is empty", () => {
    const block = renderKnownObjectsBlock([], [{ qname: "publish.X", role: "unknown", evidence: [] }])
    expect(block).toContain("publish.X | unknown | \u2014")
  })
})

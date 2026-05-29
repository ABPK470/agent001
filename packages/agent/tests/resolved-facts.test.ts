import { describe, expect, it } from "vitest"
import { RESOLVED_FACTS_BUDGET_BYTES, buildResolvedFacts } from "../src/application/core/doctrine-cluster/resolved-facts.js"

describe("resolvedFacts builder", () => {
  it("returns empty string when there are no facts", () => {
    expect(buildResolvedFacts({ largeObjects: [] })).toBe("")
  })

  it("emits mirror=EXISTS or mirror absent per object", () => {
    const out = buildResolvedFacts({
      largeObjects: [
        { name: "publish.revenue", hasPersistedMirror: false, branchCount: 59 },
        { name: "publish.balances", hasPersistedMirror: true, branchCount: 12, note: "ranked balance read" },
      ],
    })
    expect(out).toContain("publish.revenue")
    expect(out).toContain("no persistedView mirror")
    expect(out).toContain("59 union branches")
    expect(out).toContain("publish.balances")
    expect(out).toContain("persistedView mirror EXISTS")
    expect(out).toContain("ranked balance read")
  })

  it("includes schema fingerprint when supplied", () => {
    const out = buildResolvedFacts({
      largeObjects: [{ name: "publish.revenue", hasPersistedMirror: false }],
      schemaFingerprint: "abc123de",
    })
    expect(out).toContain("schema fingerprint: abc123de")
  })

  it("output stays under the byte budget for plausible input sizes", () => {
    const objects = Array.from({ length: 8 }, (_, i) => ({
      name: `publish.bigobject${i}`,
      hasPersistedMirror: i % 2 === 0,
      branchCount: 10 + i,
      note: "ranked read",
    }))
    const out = buildResolvedFacts({ largeObjects: objects, schemaFingerprint: "deadbeef" })
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(RESOLVED_FACTS_BUDGET_BYTES)
  })

  it("throws when input would exceed the byte budget", () => {
    const objects = Array.from({ length: 60 }, (_, i) => ({
      name: `publish.veryverylongobjectname${i}`,
      hasPersistedMirror: false,
      branchCount: 999,
      note: "lengthy descriptive note about the data set and its properties",
    }))
    expect(() => buildResolvedFacts({ largeObjects: objects })).toThrow(/exceeds .*B budget/)
  })

  // ── Plan v3 Phase 7 — per-candidate cross-references ────────────

  it("renders fanInRows when provided (formatted in millions for large values)", () => {
    const out = buildResolvedFacts({
      largeObjects: [
        { name: "publish.revenue", hasPersistedMirror: false, fanInRows: 270_000_000 },
        { name: "publish.smallview", hasPersistedMirror: false, fanInRows: 500 },
      ],
    })
    expect(out).toContain("270M source rows")
    expect(out).toContain("500 source rows")
  })

  it("renders structuralRank when provided", () => {
    const out = buildResolvedFacts({
      largeObjects: [
        { name: "publish.revenue", hasPersistedMirror: false, structuralRank: 1 },
        { name: "publish.revenueesgrules", hasPersistedMirror: false, structuralRank: 2 },
      ],
    })
    expect(out).toContain("rank #1 in sibling cluster")
    expect(out).toContain("rank #2 in sibling cluster")
  })

  it("renders verdictRole when provided", () => {
    const out = buildResolvedFacts({
      largeObjects: [
        { name: "publish.revenue", hasPersistedMirror: false, verdictRole: "canonical" },
        { name: "publish.revenueesgrules", hasPersistedMirror: false, verdictRole: "subset" },
      ],
    })
    expect(out).toContain("prior verdict: canonical")
    expect(out).toContain("prior verdict: subset")
  })

  it("omits the new fields silently when not supplied (back-compat)", () => {
    const out = buildResolvedFacts({
      largeObjects: [{ name: "publish.revenue", hasPersistedMirror: false }],
    })
    expect(out).not.toContain("source rows")
    expect(out).not.toContain("rank #")
    expect(out).not.toContain("prior verdict")
  })
})

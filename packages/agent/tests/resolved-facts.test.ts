import { describe, expect, it } from "vitest"
import { RESOLVED_FACTS_BUDGET_BYTES, buildResolvedFacts } from "../src/doctrine/resolved-facts.js"

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
})

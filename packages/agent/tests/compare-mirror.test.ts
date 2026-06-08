/**
 * Plan v3 Phase 2 — profile_data(compareMirror=true) generic MSSQL primitive.
 *
 * Tests the pure decision function `decideMirrorRecommendation` which is
 * the LLM-facing brain of the new mode. Generic across any MSSQL DB
 * with a `<mirrorSchema>.<canonical-qname>` convention.
 *
 * Thresholds (production defaults):
 *   - MAX_DELTA_PCT     = 5     (|mirror_rows - canonical_rows| / canonical_rows × 100)
 *   - MAX_FRESH_HOURS   = 24    (now - mirror.STATS_DATE)
 *
 * Recommendation enum:
 *   - USE_MIRROR        — safe substitute (within both thresholds)
 *   - USE_CANONICAL     — mirror doesn't exist
 *   - INSUFFICIENT_DATA — anything else (stale, drifted, suspicious, unknown)
 */
import { describe, expect, it } from "vitest"
import { decideMirrorRecommendation } from "../src/tools/mssql-profiler.js"

function stats(qname: string, rows: number | null, statsDate: Date | null, exists = true) {
  return { qname, rows, statsDate, exists }
}

const NOW = new Date("2026-05-22T12:00:00Z")

describe("decideMirrorRecommendation — happy path", () => {
  it("recommends USE_MIRROR when within deltaPct AND freshness thresholds", () => {
    const fresh = new Date("2026-05-22T08:00:00Z") // 4h ago
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100_000_000, new Date("2026-05-22T07:00:00Z")),
      stats("persistedView.publish.Revenue", 100_010_000, fresh),
      NOW
    )
    expect(r.recommendation).toBe("USE_MIRROR")
    expect(r.deltaPct).toBe(0.01)
    expect(r.freshHours).toBe(4)
  })
})

describe("decideMirrorRecommendation — guards", () => {
  it("USE_CANONICAL when mirror does not exist", () => {
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100_000_000, NOW),
      stats("persistedView.publish.Revenue", null, null, false),
      NOW
    )
    expect(r.recommendation).toBe("USE_CANONICAL")
    expect(r.reason).toMatch(/does not exist/i)
  })

  it("INSUFFICIENT_DATA when canonical does not exist", () => {
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", null, null, false),
      stats("persistedView.publish.Revenue", 1_000, NOW),
      NOW
    )
    expect(r.recommendation).toBe("INSUFFICIENT_DATA")
    expect(r.reason).toMatch(/canonical/i)
  })

  it("INSUFFICIENT_DATA when canonical has zero rows", () => {
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 0, NOW),
      stats("persistedView.publish.Revenue", 0, NOW),
      NOW
    )
    expect(r.recommendation).toBe("INSUFFICIENT_DATA")
    expect(r.reason).toMatch(/zero rows/i)
  })

  it("INSUFFICIENT_DATA when mirror has more rows than canonical (suspicious)", () => {
    // Duplicate load, missing predicate, or schema drift → refuse substitution.
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100_000_000, NOW),
      stats("persistedView.publish.Revenue", 110_000_000, NOW), // +10%
      NOW
    )
    expect(r.recommendation).toBe("INSUFFICIENT_DATA")
    expect(r.reason).toMatch(/more rows/i)
  })

  it("INSUFFICIENT_DATA when row delta exceeds threshold (mirror is stale-by-rows)", () => {
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100_000_000, NOW),
      stats("persistedView.publish.Revenue", 90_000_000, NOW), // −10%
      NOW
    )
    expect(r.recommendation).toBe("INSUFFICIENT_DATA")
    expect(r.reason).toMatch(/delta/i)
    expect(r.deltaPct).toBe(-10)
  })

  it("INSUFFICIENT_DATA when mirror has no STATS_DATE (freshness unknown)", () => {
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100, NOW),
      stats("persistedView.publish.Revenue", 100, null),
      NOW
    )
    expect(r.recommendation).toBe("INSUFFICIENT_DATA")
    expect(r.reason).toMatch(/STATS_DATE/i)
  })

  it("INSUFFICIENT_DATA when mirror stats are too old", () => {
    const stale = new Date("2026-05-20T00:00:00Z") // 60h ago
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100, NOW),
      stats("persistedView.publish.Revenue", 100, stale),
      NOW
    )
    expect(r.recommendation).toBe("INSUFFICIENT_DATA")
    expect(r.reason).toMatch(/24h/)
    expect(r.freshHours).toBe(60)
  })

  it("respects custom thresholds when supplied", () => {
    // Tighter delta (1%) and looser freshness (48h) — both flipped from defaults.
    const oldButOk = new Date("2026-05-21T00:00:00Z") // 36h ago
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100_000, NOW),
      stats("persistedView.publish.Revenue", 100_500, oldButOk), // 0.5%
      NOW,
      1, // maxDeltaPct
      48 // maxFreshHours
    )
    expect(r.recommendation).toBe("USE_MIRROR")
  })
})

describe("decideMirrorRecommendation — return shape", () => {
  it("returns serializable date strings (ISO) for both stats_date fields", () => {
    const d1 = new Date("2026-05-22T07:00:00Z")
    const d2 = new Date("2026-05-22T08:00:00Z")
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100, d1),
      stats("persistedView.publish.Revenue", 100, d2),
      NOW
    )
    expect(r.canonical.statsDate).toBe(d1.toISOString())
    expect(r.mirror.statsDate).toBe(d2.toISOString())
    expect(r.canonical.qname).toBe("publish.Revenue")
    expect(r.mirror.qname).toBe("persistedView.publish.Revenue")
  })

  it("returns null statsDate fields when underlying dates are null", () => {
    const r = decideMirrorRecommendation(
      stats("publish.Revenue", 100, null),
      stats("persistedView.publish.Revenue", null, null, false),
      NOW
    )
    expect(r.canonical.statsDate).toBeNull()
    expect(r.mirror.statsDate).toBeNull()
  })
})

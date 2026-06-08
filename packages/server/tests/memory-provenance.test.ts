/**
 * Phase 5: memory provenance — stamps + demotion behavior.
 *
 * These tests exercise the pure functions in `provenance.ts` without
 * touching the SQLite layer; the retrieval-side integration is verified
 * by `memory-tenancy.test.ts` and friends through the full pipeline.
 */
import { describe, expect, it } from "vitest"
import {
  ageInDays,
  currentPolicyVersion,
  MEMORY_STALE_DAYS,
  PROVENANCE_KEYS,
  provenanceMultiplier,
  stampProvenance
} from "../src/platform/persistence/memory/provenance.js"

const now = new Date("2026-05-21T12:00:00Z")
function isoDaysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

describe("memory provenance — stamping", () => {
  it("stamps policyVersion when missing", () => {
    const stamped = stampProvenance({})
    expect(stamped[PROVENANCE_KEYS.policyVersion]).toBe(currentPolicyVersion())
  })

  it("preserves caller-supplied policyVersion (idempotent)", () => {
    const stamped = stampProvenance({ [PROVENANCE_KEYS.policyVersion]: "x@9.9.9" })
    expect(stamped[PROVENANCE_KEYS.policyVersion]).toBe("x@9.9.9")
  })

  it("stamps schemaFingerprint when supplied", () => {
    const stamped = stampProvenance({}, { schemaFingerprint: "sha1:abc" })
    expect(stamped[PROVENANCE_KEYS.schemaFingerprint]).toBe("sha1:abc")
  })

  it("does NOT mutate the input metadata", () => {
    const input = { foo: 1 }
    stampProvenance(input)
    expect(input).toEqual({ foo: 1 })
  })
})

describe("memory provenance — demotion multiplier", () => {
  const fresh = isoDaysAgo(1)
  const current = currentPolicyVersion()

  it("no penalty when entry matches current policy and is fresh", () => {
    const { multiplier, reasons } = provenanceMultiplier(
      { [PROVENANCE_KEYS.policyVersion]: current },
      fresh,
      current,
      null,
      now
    )
    expect(multiplier).toBe(1)
    expect(reasons).toEqual([])
  })

  it("halves score on policy mismatch", () => {
    const { multiplier, reasons } = provenanceMultiplier(
      { [PROVENANCE_KEYS.policyVersion]: "stale@0.0.1" },
      fresh,
      current,
      null,
      now
    )
    expect(multiplier).toBe(0.5)
    expect(reasons).toContain("policy_mismatch")
  })

  it("applies schema-drift multiplier when fingerprint differs", () => {
    const { multiplier, reasons } = provenanceMultiplier(
      {
        [PROVENANCE_KEYS.policyVersion]: current,
        [PROVENANCE_KEYS.schemaFingerprint]: "old"
      },
      fresh,
      current,
      "new",
      now
    )
    expect(multiplier).toBe(0.4)
    expect(reasons).toContain("schema_drift")
  })

  it("decays past staleness window", () => {
    const old = isoDaysAgo(MEMORY_STALE_DAYS + 10)
    const { multiplier, reasons } = provenanceMultiplier(
      { [PROVENANCE_KEYS.policyVersion]: current },
      old,
      current,
      null,
      now
    )
    expect(multiplier).toBeLessThan(1)
    expect(multiplier).toBeGreaterThan(0)
    expect(reasons.some((r) => r.startsWith("age_"))).toBe(true)
  })

  it("never returns 0 even for ancient + drifted entries", () => {
    const ancient = isoDaysAgo(365)
    const { multiplier } = provenanceMultiplier(
      {
        [PROVENANCE_KEYS.policyVersion]: "stale",
        [PROVENANCE_KEYS.schemaFingerprint]: "old"
      },
      ancient,
      current,
      "new",
      now
    )
    expect(multiplier).toBeGreaterThan(0)
  })

  it("treats missing provenance as neutral (no demotion)", () => {
    const { multiplier, reasons } = provenanceMultiplier({}, fresh, current, null, now)
    expect(multiplier).toBe(1)
    expect(reasons).toEqual([])
  })
})

describe("memory provenance — ageInDays", () => {
  it("returns 0 for future timestamps", () => {
    const future = new Date(now.getTime() + 86_400_000).toISOString()
    expect(ageInDays(future, now)).toBe(0)
  })
  it("returns whole days for past timestamps", () => {
    expect(ageInDays(isoDaysAgo(5), now)).toBe(5)
  })
  it("returns 0 for invalid timestamps", () => {
    expect(ageInDays("not-a-date", now)).toBe(0)
  })
})

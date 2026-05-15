/**
 * Fingerprint pool: deterministic with a seed, randomised without.
 */

import { describe, expect, it } from "vitest"

import { fingerprintPoolSize, pickFingerprint } from "../src/tools/browse-web/fingerprint.js"

describe("browse-web fingerprint", () => {
  it("returns the same fingerprint for the same seed", () => {
    const a = pickFingerprint("user@example.com")
    const b = pickFingerprint("user@example.com")
    expect(a.userAgent).toBe(b.userAgent)
    expect(a.viewport).toEqual(b.viewport)
    expect(a.locale).toBe(b.locale)
    expect(a.timezoneId).toBe(b.timezoneId)
  })

  it("returns different fingerprints for different seeds (across the pool)", () => {
    // Sample a handful of seeds; we should hit at least two distinct slots
    const uas = new Set<string>()
    for (const s of ["alice", "bob", "carol", "dave", "eve", "frank", "grace"]) {
      uas.add(pickFingerprint(s).userAgent)
    }
    expect(uas.size).toBeGreaterThan(1)
  })

  it("returns a defensive copy of viewport so callers can't mutate the pool", () => {
    const a = pickFingerprint("seed-x")
    a.viewport.width = 9999
    const b = pickFingerprint("seed-x")
    expect(b.viewport.width).not.toBe(9999)
  })

  it("pool is non-empty", () => {
    expect(fingerprintPoolSize()).toBeGreaterThan(0)
  })

  it("works with no seed (random selection)", () => {
    const fp = pickFingerprint()
    expect(fp.userAgent).toMatch(/Mozilla\/5\.0/)
    expect(fp.viewport.width).toBeGreaterThan(0)
  })
})

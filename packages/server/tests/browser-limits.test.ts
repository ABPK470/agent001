/**
 * Per-tenant concurrency + per-(upn,domain) token bucket.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

beforeEach(async () => {
  const { _resetLimits } = await import("../src/features/browser/limits.js")
  _resetLimits()
})

afterEach(async () => {
  const { _resetLimits } = await import("../src/features/browser/limits.js")
  _resetLimits()
})

describe("browser limits — concurrency", () => {
  it("acquires up to MAX_PER_USER then queues", async () => {
    const { acquireUserSlot, _userInFlight, limitsConfig } = await import("../src/features/browser/limits.js")

    const acquired: Array<() => void> = []
    for (let i = 0; i < limitsConfig.maxPerUser; i++) {
      acquired.push(await acquireUserSlot("alice@x"))
    }
    expect(_userInFlight("alice@x")).toBe(limitsConfig.maxPerUser)

    let resolvedFourth = false
    const fourthPromise = acquireUserSlot("alice@x").then((release) => {
      resolvedFourth = true
      return release
    })

    // Tick — fourth should still be queued.
    await new Promise((r) => setTimeout(r, 5))
    expect(resolvedFourth).toBe(false)

    acquired[0]!()
    const release4 = await fourthPromise
    expect(resolvedFourth).toBe(true)
    release4()

    // Release the rest.
    for (let i = 1; i < acquired.length; i++) acquired[i]!()
    expect(_userInFlight("alice@x")).toBe(0)
  })
})

describe("browser limits — token bucket", () => {
  it("starts full and consumes one token per request", async () => {
    const { tryConsumeDomainToken, limitsConfig } = await import("../src/features/browser/limits.js")

    let allowed = 0
    let blocked = 0
    for (let i = 0; i < limitsConfig.domainRpm + 5; i++) {
      const r = tryConsumeDomainToken("alice@x", "example.com")
      if (r.allowed) allowed++
      else blocked++
    }
    expect(allowed).toBe(limitsConfig.domainRpm)
    expect(blocked).toBe(5)
  })

  it("isolates tenants and domains", async () => {
    const { tryConsumeDomainToken, _resetLimits, limitsConfig } = await import("../src/features/browser/limits.js")
    _resetLimits()

    // Drain alice@example.com
    for (let i = 0; i < limitsConfig.domainRpm; i++) {
      tryConsumeDomainToken("alice@x", "example.com")
    }
    // Bob still has a full bucket on the same host.
    expect(tryConsumeDomainToken("bob@y", "example.com").allowed).toBe(true)
    // Alice still has a full bucket on a different host.
    expect(tryConsumeDomainToken("alice@x", "other.com").allowed).toBe(true)
  })
})

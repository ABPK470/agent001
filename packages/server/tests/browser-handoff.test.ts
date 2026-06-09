/**
 * Visible-browser handoff registry: minting, tenant isolation, lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

beforeEach(async () => {
  const { _resetHandoffs } = await import("../src/features/browser/application/handoff.js")
  _resetHandoffs()
})

afterEach(async () => {
  const { _resetHandoffs } = await import("../src/features/browser/application/handoff.js")
  _resetHandoffs()
})

describe("browser handoff registry", () => {
  it("mints, lists, and isolates tenants", async () => {
    const { mintHandoff, getHandoff, listHandoffs } =
      await import("../src/features/browser/application/handoff.js")
    const a = mintHandoff({ ownerUpn: "alice@x", browserSessionId: "s1", reason: "captcha" })
    mintHandoff({ ownerUpn: "bob@x", browserSessionId: "s2", reason: "2fa" })

    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.url).toBe(`/browser/handoff/${a.token}`)
    expect(a.status).toBe("pending")

    expect(listHandoffs("alice@x").length).toBe(1)
    expect(listHandoffs("bob@x").length).toBe(1)
    expect(getHandoff("bob@x", a.id)).toBeNull()
    expect(getHandoff("alice@x", a.id)?.id).toBe(a.id)
  })

  it("completes a handoff and resolves awaiters", async () => {
    const { mintHandoff, completeHandoff, awaitHandoff } =
      await import("../src/features/browser/application/handoff.js")
    const rec = mintHandoff({ ownerUpn: "alice@x", browserSessionId: "s1", reason: "captcha" })
    const promise = awaitHandoff(rec.id)
    completeHandoff("alice@x", rec.id)
    const final = await promise
    expect(final.status).toBe("completed")
  })

  it("revokes a handoff", async () => {
    const { mintHandoff, revokeHandoff, awaitHandoff } =
      await import("../src/features/browser/application/handoff.js")
    const rec = mintHandoff({ ownerUpn: "alice@x", browserSessionId: "s1", reason: "manual" })
    const promise = awaitHandoff(rec.id)
    expect(revokeHandoff("alice@x", rec.id)).toBe(true)
    const final = await promise
    expect(final.status).toBe("revoked")
  })

  it("expires after TTL", async () => {
    const { mintHandoff, getHandoff } = await import("../src/features/browser/application/handoff.js")
    const rec = mintHandoff({
      ownerUpn: "alice@x",
      browserSessionId: "s1",
      reason: "captcha",
      ttlMs: 1
    })
    await new Promise((r) => setTimeout(r, 10))
    const fetched = getHandoff("alice@x", rec.id)
    expect(fetched?.status).toBe("expired")
  })

  it("refuses cross-tenant complete and revoke", async () => {
    const { mintHandoff, completeHandoff, revokeHandoff } =
      await import("../src/features/browser/application/handoff.js")
    const rec = mintHandoff({ ownerUpn: "alice@x", browserSessionId: "s1", reason: "captcha" })
    expect(completeHandoff("bob@x", rec.id)).toBe(false)
    expect(revokeHandoff("bob@x", rec.id)).toBe(false)
  })
})

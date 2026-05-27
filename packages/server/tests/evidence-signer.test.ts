/**
 * F1.8 — HMAC signer + envelope round-trip tests.
 */

import { describe, expect, it } from "vitest"
import type { EnvelopeHeader } from "../src/adapters/persistence/evidence/envelope.js"
import { buildEnvelope, envelopeBodyBytes, envelopeBodyHash, recomputeHashChain } from "../src/adapters/persistence/evidence/index.js"
import { buildHmacSigner } from "../src/adapters/persistence/evidence/signers/hmac.js"

function header(): EnvelopeHeader {
  return {
    version:    1,
    id:         "ev-1",
    createdAt:  "2025-01-15T12:00:00.000Z",
    tenantId:   "_default",
    planId:     "plan-1",
    proposalId: null,
    envPair:    { source: "uat", target: "prod" },
    actor:      "alice",
    outcome:    "success",
  }
}

describe("evidence signer + envelope (F1.8)", () => {
  it("HMAC signer round-trips", async () => {
    const s = buildHmacSigner({ id: "test", secret: "y".repeat(48) })
    const sig = await s.sign(Buffer.from("hello"))
    expect(typeof sig).toBe("string")
    expect(await s.verify(Buffer.from("hello"), sig)).toBe(true)
    expect(await s.verify(Buffer.from("HELLO"), sig)).toBe(false)
  })

  it("hashChain over body sections is stable + verifiable", () => {
    const env = buildEnvelope({
      header: header(),
      proposal: { id: "p" }, annotation: null, plan: { steps: [] },
      approval: null, execution: { startedAt: "t", finishedAt: "t2", durationMs: 1, counts: { planned: 0, executed: 0 }, error: null },
      verification: null, audit: [],
    })
    expect(env.hashChain).toHaveLength(8)
    expect(recomputeHashChain(env)).toEqual([])
  })

  it("hashChain detects body tampering", () => {
    const env = buildEnvelope({
      header: header(),
      proposal: { id: "p" }, annotation: null, plan: { steps: [] },
      approval: null, execution: { startedAt: "t", finishedAt: "t2", durationMs: 1, counts: { planned: 0, executed: 0 }, error: null },
      verification: null, audit: [],
    })
    const tampered = { ...env, proposal: { id: "MUTATED" } }
    expect(recomputeHashChain(tampered).length).toBeGreaterThan(0)
  })

  it("envelopeBodyHash is stable", () => {
    const env = buildEnvelope({
      header: header(),
      proposal: null, annotation: null, plan: null, approval: null,
      execution: null, verification: null, audit: [],
    })
    expect(envelopeBodyHash(env)).toEqual(envelopeBodyHash(env))
    expect(envelopeBodyBytes(env).length).toBeGreaterThan(0)
  })
})

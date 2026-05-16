/**
 * F1.8 — Verifier core tests.
 *
 * Builds an envelope, signs it with the HMAC signer, then exercises the
 * verifier for OK, hash-chain tamper, signature tamper, parse failure,
 * and "no signer" paths.
 */

import { describe, expect, it } from "vitest"
import {
    buildEnvelope, envelopeBodyBytes, envelopeBodyHash,
    VerificationCode, verifyEvidence,
    type EnvelopeHeader,
    type EvidenceEnvelope,
} from "../src/evidence/index.js"
import { buildHmacSigner } from "../src/evidence/signers/hmac.js"

const SECRET = "z".repeat(48)

function header(): EnvelopeHeader {
  return {
    version: 1, id: "ev-1", createdAt: "2025-01-15T12:00:00.000Z",
    tenantId: "_default", planId: "plan-1", proposalId: null,
    envPair: { source: "uat", target: "prod" }, actor: "alice", outcome: "success",
  }
}

async function buildSigned(): Promise<{ env: EvidenceEnvelope; json: string }> {
  const signer = buildHmacSigner({ id: "test", secret: SECRET })
  const env = buildEnvelope({
    header: header(),
    proposal: { id: "p" }, annotation: null, plan: { steps: [] },
    approval: null, execution: null, verification: null, audit: [],
  })
  const sig = await signer.sign(envelopeBodyBytes(env))
  const signed: EvidenceEnvelope = {
    ...env,
    signature: { alg: signer.alg, signerId: signer.id, value: sig, contentHash: envelopeBodyHash(env) },
  }
  return { env: signed, json: JSON.stringify(signed) }
}

describe("verifyEvidence (F1.8)", () => {
  it("OK on a valid signed envelope", async () => {
    const { json } = await buildSigned()
    const r = await verifyEvidence({ envelopeJson: json, signer: buildHmacSigner({ id: "test", secret: SECRET }) })
    expect(r.code).toBe(VerificationCode.Ok)
    expect(r.ok).toBe(true)
  })

  it("HashChain code on body tamper", async () => {
    const { env } = await buildSigned()
    const tampered = JSON.stringify({ ...env, proposal: { id: "MUTATED" } })
    const r = await verifyEvidence({ envelopeJson: tampered, signer: buildHmacSigner({ id: "test", secret: SECRET }) })
    expect(r.code).toBe(VerificationCode.HashChain)
  })

  it("Signature code when signer key differs", async () => {
    const { json } = await buildSigned()
    const r = await verifyEvidence({ envelopeJson: json, signer: buildHmacSigner({ id: "test", secret: "different".repeat(8) }) })
    expect(r.code).toBe(VerificationCode.Signature)
  })

  it("Parse code on broken JSON", async () => {
    const r = await verifyEvidence({ envelopeJson: "{ not json", signer: null })
    expect(r.code).toBe(VerificationCode.Parse)
  })

  it("Parse code (unsigned) when envelope lacks signature", async () => {
    const env = buildEnvelope({
      header: header(), proposal: null, annotation: null, plan: null,
      approval: null, execution: null, verification: null, audit: [],
    })
    const r = await verifyEvidence({ envelopeJson: JSON.stringify(env), signer: null })
    expect(r.code).toBe(VerificationCode.Parse)
    expect(r.message).toMatch(/unsigned/i)
  })

  it("Io code when no signer provided for a signed envelope", async () => {
    const { json } = await buildSigned()
    const r = await verifyEvidence({ envelopeJson: json, signer: null })
    expect(r.code).toBe(VerificationCode.Io)
  })
})

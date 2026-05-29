/**
 * F1.8 — Verifier core.
 *
 * Pure verification logic shared by:
 *   - GET /api/sync/evidence/:planId/verify  (route)
 *   - scripts/verify-evidence.mjs            (offline CLI)
 *
 * Exit codes (also used by the CLI):
 *    0 — envelope verified end-to-end
 *   10 — hash chain mismatch (envelope body tampered)
 *   20 — signature did not verify (signer/key mismatch or tamper)
 *   30 — JSON parse error / structural failure
 *   40 — IO / configuration failure (signer unavailable, file missing)
 */

import {
    envelopeBodyBytes,
    recomputeHashChain,
    type EnvelopeSection,
    type EvidenceEnvelope,
} from "./envelope.js"
import type { Signer } from "./signer.js"

export const VerificationCode = {
  Ok:          0,
  HashChain:  10,
  Signature:  20,
  Parse:      30,
  Io:         40,
} as const
export type VerificationCode = (typeof VerificationCode)[keyof typeof VerificationCode]

export interface VerificationReport {
  code:        VerificationCode
  ok:          boolean
  message:     string
  failed:      readonly EnvelopeSection[]
  signerId?:   string
  contentHash?: string
}

export interface VerifyInput {
  /** Raw envelope JSON text (e.g. from disk). */
  envelopeJson: string
  /** Resolved signer for the embedded signer.id+alg pair. */
  signer:       Signer | null
}

export async function verifyEvidence(i: VerifyInput): Promise<VerificationReport> {
  let env: EvidenceEnvelope
  try {
    env = JSON.parse(i.envelopeJson) as EvidenceEnvelope
  } catch (e) {
    return {
      code: VerificationCode.Parse, ok: false,
      message: `envelope JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
      failed: [],
    }
  }
  if (!env.signature) {
    return {
      code: VerificationCode.Parse, ok: false,
      message: "envelope is unsigned",
      failed: [],
    }
  }
  const chain = recomputeHashChain(env)
  if (chain.length > 0) {
    return {
      code: VerificationCode.HashChain, ok: false,
      message: `hash chain mismatch for: ${chain.join(", ")}`,
      failed: chain,
      signerId: env.signature.signerId, contentHash: env.signature.contentHash,
    }
  }
  if (!i.signer) {
    return {
      code: VerificationCode.Io, ok: false,
      message: `no signer registered for "${env.signature.alg}" / "${env.signature.signerId}"`,
      failed: [],
      signerId: env.signature.signerId, contentHash: env.signature.contentHash,
    }
  }
  let valid = false
  try { valid = await i.signer.verify(envelopeBodyBytes(env), env.signature.value) }
  catch (e) {
    return {
      code: VerificationCode.Io, ok: false,
      message: `signer threw during verify: ${e instanceof Error ? e.message : String(e)}`,
      failed: [],
      signerId: env.signature.signerId, contentHash: env.signature.contentHash,
    }
  }
  if (!valid) {
    return {
      code: VerificationCode.Signature, ok: false,
      message: "signature did not verify",
      failed: [],
      signerId: env.signature.signerId, contentHash: env.signature.contentHash,
    }
  }
  return {
    code: VerificationCode.Ok, ok: true,
    message: "envelope verified",
    failed: [],
    signerId: env.signature.signerId, contentHash: env.signature.contentHash,
  }
}

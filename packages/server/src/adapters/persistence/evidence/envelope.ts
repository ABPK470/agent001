/**
 * F1.8 — Evidence envelope (canonical JSON).
 *
 * The envelope is the durable, machine-verifiable record of one sync
 * execution. Layout (all sections are required):
 *
 *  {
 *    "envelope": { "version": 1, "id", "createdAt", "tenantId", "planId",
 *                  "proposalId" | null, "envPair", "actor", "outcome" },
 *    "proposal":      { ... ProposalRow snapshot (parsed)            },
 *    "annotation":    { ... RiskAnnotation snapshot or null          },
 *    "plan":          { ... SyncPlan snapshot                        },
 *    "approval":      { ... ApprovalRow snapshot or null             },
 *    "execution":     { startedAt, finishedAt, durationMs, counts:
 *                       { planned, executed }, error|null },
 *    "verification":  { ... VerificationReport (F1.11) or null       },
 *    "audit":         [ ... lifecycle history rows                   ],
 *    "hashChain":     [ "sha256:<hex>" ] one per section in declared order
 *  }
 *
 * The `hashChain` is computed over canonical-JSON of each section, in
 * the declared order. The signature (F1.8 signers/) signs the
 * canonical-JSON of the envelope **with `signature` field absent**.
 */

import {
    canonicalJsonStringify,
    canonicalSha256,
    sha256Hex,
} from "@mia/sync"

export const ENVELOPE_VERSION = 1 as const

export const ENVELOPE_SECTIONS = [
  "envelope",
  "proposal",
  "annotation",
  "plan",
  "approval",
  "execution",
  "verification",
  "audit",
] as const

export type EnvelopeSection = (typeof ENVELOPE_SECTIONS)[number]

export interface EnvelopeHeader {
  version:    1
  id:         string
  createdAt:  string
  tenantId:   string
  planId:     string
  proposalId: string | null
  envPair:    { source: string; target: string }
  actor:      string
  outcome:    "success" | "failed"
}

export interface EnvelopeSignature {
  alg:       string
  signerId:  string
  /** base64url-encoded detached signature over canonical-JSON of body. */
  value:     string
  /** SHA-256 of the body (before signing). */
  contentHash: string
}

export interface EvidenceEnvelope {
  envelope:     EnvelopeHeader
  proposal:     unknown
  annotation:   unknown
  plan:         unknown
  approval:     unknown
  execution:    unknown
  verification: unknown
  audit:        readonly unknown[]
  hashChain:    readonly string[]
  signature?:   EnvelopeSignature
}

// ── builder ─────────────────────────────────────────────────────

export interface BuildEnvelopeInput {
  header:       EnvelopeHeader
  proposal:     unknown
  annotation:   unknown
  plan:         unknown
  approval:     unknown
  execution:    unknown
  verification: unknown
  audit:        readonly unknown[]
}

/**
 * Build the canonical (unsigned) envelope. Sections that are
 * intentionally absent (e.g. no approval was needed) MUST be passed as
 * explicit `null`, not `undefined`, so the hash chain is stable.
 */
export function buildEnvelope(i: BuildEnvelopeInput): EvidenceEnvelope {
  const sections: Record<EnvelopeSection, unknown> = {
    envelope:     i.header,
    proposal:     i.proposal,
    annotation:   i.annotation,
    plan:         i.plan,
    approval:     i.approval,
    execution:    i.execution,
    verification: i.verification,
    audit:        i.audit,
  }
  const hashChain = ENVELOPE_SECTIONS.map((s) => `sha256:${canonicalSha256(sections[s])}`)
  return {
    envelope:     i.header,
    proposal:     i.proposal,
    annotation:   i.annotation,
    plan:         i.plan,
    approval:     i.approval,
    execution:    i.execution,
    verification: i.verification,
    audit:        i.audit,
    hashChain,
  }
}

/** Serialise envelope body (no signature) → bytes the signer signs. */
export function envelopeBodyBytes(env: EvidenceEnvelope): Buffer {
  const body: Omit<EvidenceEnvelope, "signature"> = {
    envelope:     env.envelope,
    proposal:     env.proposal,
    annotation:   env.annotation,
    plan:         env.plan,
    approval:     env.approval,
    execution:    env.execution,
    verification: env.verification,
    audit:        env.audit,
    hashChain:    env.hashChain,
  }
  return Buffer.from(canonicalJsonStringify(body), "utf-8")
}

export function envelopeBodyHash(env: EvidenceEnvelope): string {
  return sha256Hex(envelopeBodyBytes(env))
}

// ── recompute (used by verifier) ───────────────────────────────

/**
 * Recompute the hashChain over the body sections and compare against the
 * stored chain. Returns the indices that diverge (empty = chain valid).
 */
export function recomputeHashChain(env: EvidenceEnvelope): readonly EnvelopeSection[] {
  const failed: EnvelopeSection[] = []
  const sections: Record<EnvelopeSection, unknown> = {
    envelope:     env.envelope,
    proposal:     env.proposal,
    annotation:   env.annotation,
    plan:         env.plan,
    approval:     env.approval,
    execution:    env.execution,
    verification: env.verification,
    audit:        env.audit,
  }
  for (let i = 0; i < ENVELOPE_SECTIONS.length; i++) {
    const expected = env.hashChain[i]
    const actual   = `sha256:${canonicalSha256(sections[ENVELOPE_SECTIONS[i]!])}`
    if (expected !== actual) failed.push(ENVELOPE_SECTIONS[i]!)
  }
  return failed
}

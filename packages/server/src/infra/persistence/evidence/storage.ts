/**
 * F1.8 — Evidence storage: persist envelope + PDF to disk, index in DB.
 *
 *   data/evidence/<yyyy>/<mm>/<plan_id>.envelope.json
 *   data/evidence/<yyyy>/<mm>/<plan_id>.evidence.pdf
 *
 * The signer signs the canonical-JSON envelope (no signature field) and
 * the signed envelope is then written to disk. The `sync_evidence` row
 * records the relative paths, content hash, and signature for fast
 * lookup + verification.
 */

import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getDb } from "../db-connection.js"
import {
  buildEnvelope,
  envelopeBodyBytes,
  envelopeBodyHash,
  type BuildEnvelopeInput,
  type EvidenceEnvelope
} from "./envelope.js"
import { renderEvidencePdf } from "./pdf.js"
import type { Signer } from "./signer.js"

export interface SealedEvidence {
  id: string
  envelopePath: string
  pdfPath: string
  contentHash: string
  envelope: EvidenceEnvelope
}

export interface SealEvidenceInput extends BuildEnvelopeInput {
  tenantId: string
  /** Absolute path to the evidence storage root e.g. `<MIA_DATA_DIR>/evidence`. */
  storageRoot: string
  signer: Signer
}

export async function sealEvidence(i: SealEvidenceInput): Promise<SealedEvidence> {
  const draft = buildEnvelope({
    header: i.header,
    proposal: i.proposal,
    annotation: i.annotation,
    plan: i.plan,
    approval: i.approval,
    execution: i.execution,
    verification: i.verification,
    audit: i.audit
  })
  const bytes = envelopeBodyBytes(draft)
  const contentHash = envelopeBodyHash(draft)
  const sig = await i.signer.sign(bytes)
  const signed: EvidenceEnvelope = {
    ...draft,
    signature: {
      alg: i.signer.alg,
      signerId: i.signer.id,
      value: sig,
      contentHash
    }
  }

  const ts = new Date(i.header.createdAt)
  const yyyy = String(ts.getUTCFullYear()).padStart(4, "0")
  const mm = String(ts.getUTCMonth() + 1).padStart(2, "0")
  const folderRel = join(yyyy, mm)
  const envFile = `${i.header.planId}.envelope.json`
  const pdfFile = `${i.header.planId}.evidence.pdf`
  const envAbs = join(i.storageRoot, folderRel, envFile)
  const pdfAbs = join(i.storageRoot, folderRel, pdfFile)

  mkdirSync(dirname(envAbs), { recursive: true })
  writeFileSync(envAbs, JSON.stringify(signed, null, 2), "utf-8")
  writeFileSync(pdfAbs, renderEvidencePdf(signed))

  const id = randomUUID()
  getDb()
    .prepare(
      `
    INSERT INTO sync_evidence (id, tenant_id, plan_id, proposal_id, envelope_path, pdf_path,
                               content_hash, signature_alg, signer_id, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      id,
      i.tenantId,
      i.header.planId,
      i.header.proposalId,
      join(folderRel, envFile),
      join(folderRel, pdfFile),
      contentHash,
      i.signer.alg,
      i.signer.id,
      sig
    )

  return {
    id,
    envelopePath: join(folderRel, envFile),
    pdfPath: join(folderRel, pdfFile),
    contentHash,
    envelope: signed
  }
}

// ── lookup ──────────────────────────────────────────────────────

export interface EvidenceIndexRow {
  id: string
  tenant_id: string
  plan_id: string
  proposal_id: string | null
  envelope_path: string
  pdf_path: string | null
  content_hash: string
  signature_alg: string
  signer_id: string
  signature: string
  created_at: string
}

export function getEvidenceByPlan(planId: string): EvidenceIndexRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM sync_evidence WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(planId) as EvidenceIndexRow | undefined) ?? null
  )
}

export function listEvidence(tenantId: string, limit = 100): EvidenceIndexRow[] {
  return getDb()
    .prepare(`SELECT * FROM sync_evidence WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, limit) as EvidenceIndexRow[]
}

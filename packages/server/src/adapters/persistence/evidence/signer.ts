/**
 * F1.8 — Signer adapter interface + factory.
 *
 * Each signer implements `sign(bytes)` + `verify(bytes, sig)`. The
 * factory picks an implementation based on env config:
 *
 *   EVIDENCE_SIGNER_KIND = "hmac"      → packages/server/src/evidence/signers/hmac.ts
 *                          "file-rsa"  → file-rsa.ts        (on-prem PEM private/public key)
 *                          "kms"       → kms-stub.ts        (cloud KMS adapter facade)
 *
 * Verifier consumers (route + CLI) only see the SignerKind + signerId
 * embedded in `EnvelopeSignature` and dispatch by kind.
 */

import { buildFileRsaSigner } from "./signers/file-rsa.js"
import { buildHmacSigner } from "./signers/hmac.js"
import { buildKmsSigner } from "./signers/kms-stub.js"

export const SignerKind = {
  Hmac: "hmac",
  FileRsa: "file-rsa",
  Kms: "kms"
} as const
export type SignerKind = (typeof SignerKind)[keyof typeof SignerKind]

export interface Signer {
  /** Stable identifier embedded in `EnvelopeSignature.signerId`. */
  readonly id: string
  /** Algorithm tag e.g. "HMAC-SHA256", "RSASSA-PKCS1-v1_5-SHA256". */
  readonly alg: string
  /** Sign `bytes` and return base64url signature. */
  sign(bytes: Buffer): Promise<string>
  /** Verify a base64url signature; never throws on bad sig — returns false. */
  verify(bytes: Buffer, sig: string): Promise<boolean>
}

export interface SignerConfigError {
  kind: SignerKind
  message: string
}

/**
 * Build the signer described by environment variables.
 *
 *  - EVIDENCE_SIGNER_KIND      (default: "hmac")
 *  - EVIDENCE_SIGNER_ID        (default: "default")
 *  - EVIDENCE_HMAC_SECRET      (required for hmac)
 *  - EVIDENCE_RSA_PRIVATE_PATH (required for file-rsa; PEM)
 *  - EVIDENCE_RSA_PUBLIC_PATH  (required for file-rsa; PEM)
 *  - EVIDENCE_KMS_*            (kms adapter — see kms-stub.ts)
 *
 * Throws if mandatory config is missing. Use `tryBuildSignerFromEnv()`
 * for a non-throwing variant that returns an error description.
 */
export function buildSignerFromEnv(env: NodeJS.ProcessEnv = process.env): Signer {
  const kind = (env["EVIDENCE_SIGNER_KIND"] ?? "hmac") as SignerKind
  const id = env["EVIDENCE_SIGNER_ID"] ?? "default"
  switch (kind) {
    case "hmac": {
      const secret = env["EVIDENCE_HMAC_SECRET"]
      if (!secret) throw new Error(`EVIDENCE_SIGNER_KIND=hmac requires EVIDENCE_HMAC_SECRET`)
      return buildHmacSigner({ id, secret })
    }
    case "file-rsa": {
      const priv = env["EVIDENCE_RSA_PRIVATE_PATH"]
      const pub = env["EVIDENCE_RSA_PUBLIC_PATH"]
      if (!priv || !pub) {
        throw new Error(
          `EVIDENCE_SIGNER_KIND=file-rsa requires EVIDENCE_RSA_PRIVATE_PATH and EVIDENCE_RSA_PUBLIC_PATH`
        )
      }
      return buildFileRsaSigner({ id, privateKeyPath: priv, publicKeyPath: pub })
    }
    case "kms": {
      return buildKmsSigner({ id, env })
    }
    default:
      throw new Error(`Unknown EVIDENCE_SIGNER_KIND=${kind}`)
  }
}

export function tryBuildSignerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; signer: Signer } | { ok: false; error: SignerConfigError } {
  try {
    return { ok: true, signer: buildSignerFromEnv(env) }
  } catch (e) {
    const kind = (env["EVIDENCE_SIGNER_KIND"] ?? "hmac") as SignerKind
    return { ok: false, error: { kind, message: e instanceof Error ? e.message : String(e) } }
  }
}
